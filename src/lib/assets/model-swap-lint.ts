// Unrequested-model-swap lint (BUG_LOG 2026-08-17, "Mumbai Flight Simulator").
//
// THE INCIDENT: twenty turns into a realistic aeroplane simulator over Mumbai,
// the child asked for one thing — "take off and landing are not working. the
// game should start on the run way". The model returned a CLEANLY APPLYING
// patch that also replaced `airplane` with `spaceship`, and announced it:
// "I've swapped the plane for a super cool cartoon spaceship since it's one of
// my favorite models!". The spaceship then rode along in every later turn.
//
// WHY NOTHING CAUGHT IT: every existing edit-turn guard checks that a patch is
// mechanically sound (applies, imports resolve, no pipeline bypass — see
// three-import-lint.ts). None of them ask whether the patch changed WHAT THE
// GAME IS. And the prompt gave it room: `modelsPromptSection()` ships the whole
// ~106-model catalog on EVERY turn including edits, while
// GAME_EDIT_PROMPT_SECTION's "change only what this request needs" spoke about
// code, never about the identity of models already on screen.
//
// The prompt rule is fixed too (game-edit.ts), but a prompt rule alone is what
// rule 12 exists to warn about — the four shipped "fixes" for the race-track
// bug were all prompt rules. This is the deterministic half: pure string work,
// no model call, no network, same answer every time.
//
// GOVERNING RULE: a model already in the child's game is theirs. Dropping it is
// authorized ONLY by the child naming what should replace it, or explicitly
// asking for it to go. Anything else is a failed patch and takes the same
// strict-retry path the import lints already take.

import { MODEL_ALIASES } from "./model-alias";

/** `loadModel("x")` / `loadModelBatch("x", n)` — the two helpers injection
 *  provides, and the only ways a generated game names a library model in code
 *  (prompt-catalog.ts teaches no other). Quotes may be single, double or
 *  backtick; spacing is free-form. */
const LOAD_MODEL_RE = /\bloadModel(?:Batch)?\s*\(\s*(['"`])([a-z0-9_]+)\1/gi;

/** Every library model this game's CODE actually loads, in first-seen order.
 *
 *  Deliberately reads the loadModel CALLS, not the `<!--USES_MODELS-->` marker
 *  or the injected AR_ASSETS table: injection RECLAIMS names from the previous
 *  table (inject.ts's legacyTables), so the old model's URL survives a swap
 *  even though no code loads it any more. The table says what is available;
 *  only the call sites say what the child can SEE. */
export function loadedModelNames(html: string): string[] {
  const names: string[] = [];
  for (const m of html.matchAll(LOAD_MODEL_RE)) {
    const name = m[2]!.toLowerCase();
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** Models the patched game stopped loading — present in `before`, gone from
 *  `after`. An edit that only ADDS a model reports nothing. */
export function droppedModelNames(beforeHtml: string, afterHtml: string): string[] {
  const after = new Set(loadedModelNames(afterHtml));
  return loadedModelNames(beforeHtml).filter((n) => !after.has(n));
}

/** The words a child could plausibly use for `name`: the name itself, its
 *  underscore-separated form ("small plane"), its last word ("plane" — how a
 *  child refers to a `small_plane`), and every alias that resolves TO it
 *  ("jet" -> fighter_jet, "aeroplane" -> airplane). */
function wordsFor(name: string): string[] {
  const parts = name.split("_");
  const words = [name, parts.join(" "), parts[parts.length - 1]!];
  for (const [alias, target] of Object.entries(MODEL_ALIASES)) {
    if (target === name) words.push(alias, alias.split("_").join(" "));
  }
  return [...new Set(words)].filter(Boolean);
}

function mentions(message: string, name: string): boolean {
  return wordsFor(name).some((w) =>
    new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(message),
  );
}

/** The child asking for something to GO — the only phrasing that authorizes a
 *  drop with no replacement. Narrow on purpose: "without" and "no more" are
 *  included because children use them ("no more buildings"), but nothing here
 *  matches an ordinary description of the game. */
const REMOVAL_RE = /\b(remove|removing|delete|deleting|get rid of|take out|no more|without|don'?t want)\b/i;

/**
 * Models this patch dropped WITHOUT the child asking. Empty is the good case.
 *
 * A drop is authorized when either:
 *   · the child named a model the patch ADDED — that is a swap they asked for
 *     ("make it a jet instead" -> fighter_jet), or
 *   · the child named THIS model alongside removal language ("remove the
 *     airplane").
 *
 * Merely MENTIONING the old model is deliberately NOT authorization. Through
 * the whole Mumbai session the child kept saying "the aeroplane should…" while
 * describing what they wanted it to DO; treating that as consent to replace it
 * would re-open the exact bug this closes.
 */
export function unrequestedModelSwaps(input: { before: string; after: string; message: string }): string[] {
  const dropped = droppedModelNames(input.before, input.after);
  if (dropped.length === 0) return [];

  const beforeNames = new Set(loadedModelNames(input.before));
  const added = loadedModelNames(input.after).filter((n) => !beforeNames.has(n));
  // A replacement the child asked for by name authorizes the whole swap: they
  // said what they wanted instead, and which old model made way for it is an
  // implementation detail they neither know nor should have to state.
  if (added.some((n) => mentions(input.message, n))) return [];

  return dropped.filter((n) => !(REMOVAL_RE.test(input.message) && mentions(input.message, n)));
}
