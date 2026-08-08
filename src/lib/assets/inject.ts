// Turns a generated game's asset markers into immutable asset-host URLs
// (PRD-3D-GAMES-AND-ASSETS §5b, Part I "Injection (simplified)"). String
// concatenation ONLY — the injector never reads files and never touches the
// network, which structurally eliminates the Phase-0 failure class (a runtime
// read of a bundle the deploy didn't ship killed every 3D game in prod,
// BUG-FIX-LOG 2026-07-08). The manifest arrives as a static JSON import
// (bundled into .next at build time — nothing to ship separately).

import "server-only";
import type { AssetEntry, AssetManifest } from "./manifest";
import manifestJson from "./manifest.json";
import { THREE_MARKER, PHYSICS_MARKER, MODELS_MARKER_RE, AUDIO_MARKER_RE, stripAssetMarkers } from "./markers";
import {
  insertEarly,
  loadModelHelper,
  loadModelBatchHelper,
  audioHelper,
  creditsHelper,
  parseAssetTables,
  stripAssetTables,
  stripSizeTables,
} from "./runtime-helpers";

const CALLS_LOADMODELBATCH_RE = /\bloadModelBatch\s*\(/;

const ANY_IMPORTMAP_RE = /<script[^>]*type=["']importmap["'][^>]*>[\s\S]*?<\/script>/gi;
// Per-block, non-greedy: each match stays within one <script> tag, so dropping
// an injected helper never swallows a neighboring game script (same lesson as
// ensure-runtime's stripStaleLoadModelHelper).
const SCRIPT_BLOCK_RE = /<script[^>]*>[\s\S]*?<\/script>/g;
/** Drops echoed copies of the blocks THIS module emits (loader, batch loader,
 *  audio helper, credits chip) — each is re-emitted fresh below when needed. */
function stripInjectedHelperBlocks(html: string): string {
  return html.replace(SCRIPT_BLOCK_RE, (block) =>
    /window\.(loadModel|loadModelBatch|playSound)\s*=/.test(block) || block.includes('getElementById("ar-credits")')
      ? ""
      : block,
  );
}

// Markers are defined in ./markers (pure, non-server) so the edit-patch
// reconciliation can share them without importing this server-only module.
// Re-exported here for existing importers (prompt-catalog + inject tests).
export { THREE_MARKER, PHYSICS_MARKER } from "./markers";

/** Per-game first-load transfer cap, cold cache (PRD §8, Decision J). */
export const FIRST_LOAD_BUDGET_BYTES = 2_000_000;

/** Per-game audio cap (PRD §8, Decision J). */
export const AUDIO_BUDGET_BYTES = 500_000;

export interface InjectResult {
  html: string;
  /** Every asset-host URL this game now references — the publish-time
   *  reference ledger (PRD §5b): "forever" as an enumerable, testable set. */
  referencedUrls: string[];
  /** Marker names that did NOT make it into the game: unknown to the
   *  manifest, or dropped to hold the first-load budget. Fail-soft — the
   *  game ships without them; the route logs the list. */
  dropped: string[];
}

function parseNames(html: string, re: RegExp): string[] {
  const names: string[] = [];
  for (const m of html.matchAll(re)) {
    for (const raw of (m[1] ?? "").split(",")) {
      const name = raw.trim().toLowerCase();
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

/**
 * Resolves the game's asset markers: USES_THREE and/or USES_MODELS become an
 * import map on the engine's immutable URL (models imply the engine — the
 * loader lives in it) plus, for models, the AR_ASSETS table + loadModel
 * helper. Unmarked games pass through byte-identical — published games are
 * permanent static files and most are plain 2D.
 *
 * Budget (Decision J): referenced bytes are summed at inject time; a model
 * that would push the cold first load past 2 MB is dropped fail-soft.
 *
 * Throws when an engine is needed but the manifest has none: the route's
 * serve-raw fallback catches it and the kid still gets their game (P-class).
 */
export function injectAssets(html: string, manifest: AssetManifest = manifestJson as AssetManifest): InjectResult {
  const wantsThree = html.includes(THREE_MARKER);
  const wantsPhysics = html.includes(PHYSICS_MARKER);
  const modelNames = parseNames(html, MODELS_MARKER_RE);
  const audioNames = parseNames(html, AUDIO_MARKER_RE);
  // Edit turns echo the PREVIOUS injection back (the model is shown the stored,
  // post-injection artifact) — those tables are the only record of models the
  // existing game code still loads, and leaving them in place lets the stale
  // assignment overwrite the fresh one (BUG-FIX-LOG 2026-08-06: the Sky Patrol
  // bikes). Their names are reclaimed below; the blocks themselves are stripped.
  const legacyTables = parseAssetTables(html);
  if (!wantsThree && !wantsPhysics && modelNames.length === 0 && audioNames.length === 0 && legacyTables.length === 0) {
    return { html, referencedUrls: [], dropped: [] };
  }

  const modelsByName = new Map(manifest.assets.filter((a) => a.type === "model").map((a) => [a.name, a]));
  const audioByName = new Map(manifest.assets.filter((a) => a.type === "sfx" || a.type === "music").map((a) => [a.name, a]));

  // Reclaim manifest-known names from echoed tables: the fresh marker lists the
  // model's CURRENT intent, but turn-1 code still calls loadModel on the old
  // names. Marker names stay first so a budget squeeze drops reclaimed history
  // before this turn's ask. Names no longer in the manifest drop with the
  // table (fail-soft, same as an unknown marker name).
  for (const table of legacyTables) {
    for (const name of Object.keys(table)) {
      if (modelsByName.has(name)) {
        if (!modelNames.includes(name)) modelNames.push(name);
      } else if (audioByName.has(name) && !audioNames.includes(name)) {
        audioNames.push(name);
      }
    }
  }

  // Models imply the engine (the loader lives in it); audio alone does not.
  const needsEngine = wantsThree || modelNames.length > 0;
  // By NAME, never by type: since 2026-07-29 the host serves TWO engine-type
  // bundles (three + cannon), so find(type === "engine") would hand a game
  // whichever row happens to come first in the manifest.
  const engine = needsEngine ? manifest.assets.find((a) => a.type === "engine" && a.name === "three") : undefined;
  if (needsEngine && !engine) throw new Error("manifest has no three engine entry — run scripts/vendor-three.mjs --upload");
  const physics = wantsPhysics ? manifest.assets.find((a) => a.type === "engine" && a.name === "physics") : undefined;
  if (wantsPhysics && !physics) throw new Error("manifest has no cannon engine entry — run scripts/vendor-cannon.mjs --upload");

  const dropped: string[] = [];
  let firstLoadBytes = (engine?.bytes ?? 0) + (physics?.bytes ?? 0);

  const models: AssetEntry[] = [];
  for (const name of modelNames) {
    const entry = modelsByName.get(name);
    if (!entry) {
      dropped.push(name);
      continue;
    }
    if (firstLoadBytes + entry.bytes > FIRST_LOAD_BUDGET_BYTES) {
      dropped.push(name); // budget holds; the game ships without this one
      continue;
    }
    firstLoadBytes += entry.bytes;
    models.push(entry);
  }

  const audio: AssetEntry[] = [];
  let audioBytes = 0;
  for (const name of audioNames) {
    const entry = audioByName.get(name);
    if (!entry) {
      dropped.push(name);
      continue;
    }
    if (audioBytes + entry.bytes > AUDIO_BUDGET_BYTES || firstLoadBytes + entry.bytes > FIRST_LOAD_BUDGET_BYTES) {
      dropped.push(name);
      continue;
    }
    audioBytes += entry.bytes;
    firstLoadBytes += entry.bytes;
    audio.push(entry);
  }

  let out = stripAssetMarkers(html);
  // Strip the echoed previous injection so exactly ONE copy of each runtime
  // block survives. Document order matters: insertEarly prepends, so any stale
  // block left behind would execute LATER and win — a stale AR_ASSETS
  // assignment silently erases every model added this turn.
  out = stripAssetTables(out);
  // stripInjectedHelperBlocks keys on `window.(loadModel|loadModelBatch|
  // playSound) =`, so it does NOT catch the sizes table — without this line an
  // edit turn accumulates AR_SIZES blocks, the same duplicate-table class the
  // strip above exists for.
  out = stripSizeTables(out);
  out = stripInjectedHelperBlocks(out);
  if (engine || physics) {
    // A fresh import map is emitted below; an echoed one alongside it would be
    // browser-ignored noise (only the first map counts) — drop it.
    out = out.replace(ANY_IMPORTMAP_RE, "");
  }

  let markup = "";
  if (engine || physics) {
    const imports: Record<string, string> = {};
    if (engine) imports.three = engine.url;
    if (physics) imports["cannon-es"] = physics.url;
    markup += `<script type="importmap">${JSON.stringify({ imports })}</script>`;
  }
  const table = Object.fromEntries([...models, ...audio].map((a) => [a.name, a.url]));
  if (modelNames.length > 0 || audioNames.length > 0) {
    markup += `<script>window.AR_ASSETS=${JSON.stringify(table)};</script>`;
  }
  // The measured metres for the models in play (2026-08-08 — the
  // fragmented-track fix). Models only: sounds have no footprint. Emitted
  // BEFORE the helper purely for readability — the helper's `|| {}` guard means
  // document order is not load-bearing. Models the pipeline could not measure
  // (skinned) are simply absent, and modelSize() answers null for them.
  const sizes = Object.fromEntries(
    models.flatMap((m) => (m.size ? [[m.name, m.size] as const] : [])),
  );
  if (Object.keys(sizes).length > 0) {
    markup += `<script>window.AR_SIZES=${JSON.stringify(sizes)};</script>`;
  }
  if (modelNames.length > 0) markup += loadModelHelper();
  if (modelNames.length > 0 && CALLS_LOADMODELBATCH_RE.test(html)) markup += loadModelBatchHelper();
  if (audioNames.length > 0) markup += audioHelper();
  // CC-BY models carry an attribution duty; the chip discharges it in every
  // injected copy (preview AND published) with zero reliance on the LLM.
  const attributed = models.filter((m) => m.license === "CC-BY-3.0");
  if (attributed.length > 0) {
    markup += creditsHelper(
      attributed.map((m) => ({ name: m.name, author: m.author ?? "unknown", sourceUrl: m.sourceUrl })),
    );
  }
  out = insertEarly(out, markup);

  return {
    html: out,
    referencedUrls: [
      ...(engine ? [engine.url] : []),
      ...(physics ? [physics.url] : []),
      ...models.map((m) => m.url),
      ...audio.map((a) => a.url),
    ],
    dropped,
  };
}
