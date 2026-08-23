/**
 * The merged, human-readable view of the model library: what each model IS,
 * what it can DO, and the exact lines a game needs to use it.
 *
 * WHY THIS EXISTS (owner ask, 2026-08-21): "i need a place to look at the
 * ability of each 3d model and what we can do with each model in the game."
 * Until now that question had no answer anywhere — the manifest records bytes,
 * licence and size but not whether a model carries an animation rig, which is
 * exactly why "make the elephant walk" failing looked like a prompt bug for a
 * month (BUG-FIX-LOG 2026-08-20).
 *
 * Four sources, joined here and nowhere else:
 *   manifest.json        bytes, licence, author, size, url
 *   model-abilities.json clips + skins, committed, refreshed by
 *                        `scripts/model-animation-census.mjs --write`
 *   model-parts.json     the named nodes it carries (a car's four wheels),
 *                        refreshed by `scripts/model-parts-census.mjs --write`
 *   asset-taxonomy.ts    genres + tags (what games it suits)
 *   retired.ts           still resolvable, never offered
 *
 * Pure data, no I/O — safe for the admin bridge and for tests.
 *
 * THE ONE RULE: never infer an ability from a name. A model is reported as
 * able to walk if and only if it carries a walk clip. Guessing is what the
 * safari cull was cleaning up after.
 */

import manifestJson from "./manifest.json";
import abilitiesJson from "./model-abilities.json";
import partsJson from "./model-parts.json";
import type { AssetManifest } from "./manifest";
import { TAXONOMY } from "./asset-taxonomy";
import { RETIRED, RETIRED_MODELS } from "./retired";

export type Ability =
  | "walk" | "run" | "fly" | "swim" | "jump" | "idle"
  | "attack" | "die" | "sit" | "dance" | "emote";

/** Clip-name → ability. Ordered and anchored so `Idle_Shoot` does not read as
 *  "shoot the walk clip": each pattern matches a clip SEGMENT, not a substring
 *  of an unrelated word. */
const ABILITY_PATTERNS: ReadonlyArray<readonly [Ability, RegExp]> = [
  ["walk", /(^|_)walk/i],
  ["run", /(^|_)(run|sprint|gallop)/i],
  ["fly", /(^|_)(fly|flying|flap|glide|soar)/i],
  ["swim", /(^|_)swim/i],
  ["jump", /(^|_)jump(?!_idle)/i],
  ["idle", /(^|_)idle/i],
  ["attack", /(^|_)(attack|bite|punch|headbutt|shoot|hit)/i],
  ["die", /(^|_)(death|die)/i],
  ["sit", /(^|_)(sit|sitting)/i],
  ["dance", /(^|_)dance/i],
  ["emote", /(^|_)(yes|no|wave|hitreact|hitrecieve|hitreceive)/i],
];

/** The clip name a human reads. Games must still match the RAW string — the
 *  Quaternius exports carry armature prefixes, sometimes tripled. */
export function shortClip(raw: string): string {
  return raw.split("|").pop()!.trim();
}

/** What a model can actually do, read only from the clips it actually has. */
export function deriveAbilities(clips: readonly string[]): Ability[] {
  const out: Ability[] = [];
  for (const [ability, re] of ABILITY_PATTERNS) {
    if (clips.some((c) => re.test(shortClip(c))) && !out.includes(ability)) out.push(ability);
  }
  return out;
}

export interface ModelUsage {
  /** The marker that tells the pipeline to inject this model. */
  marker: string;
  /** Loading it, including modelSize when the model is measured. */
  load: string;
  /** Playing a clip — present ONLY when the model actually has one. */
  animate?: string;
}

export interface ModelCapability {
  name: string;
  displayName: string;
  url: string;
  bytes: number;
  license: string;
  author?: string;
  sourceUrl: string;
  /** Metres at scale 1. Absent for skinned meshes, where a bind-pose bbox is
   *  not the rendered size. */
  size?: [number, number, number];
  /** Which way the model's FRONT points at rest. Absent = unaudited, and the
   *  viewer must say "unknown" rather than draw an arrow it guessed. */
  facing?: "+x" | "-x" | "+z" | "-z";
  /** How big the thing is in REAL LIFE, metres. Absent = uncurated. Note this
   *  is the ONLY size a skinned model has — `size` is absent for all 51 rigged
   *  models, which is why `metres: true` needs a runtime measurement. */
  realSize?: [number, number, number];
  genres: string[];
  tags: string[];
  /** The named nodes the model carries — `wheel-front-left`, `Propeller_Cone`.
   *  Empty means it is one undivided mesh, and a game must add its own
   *  primitive to spin anything (the helicopter). NOT a skeleton: a wheel is
   *  rigid and merely rotates. */
  parts: string[];
  /** The subset a game would actually SPIN. */
  spinnable: string[];
  /** RAW clip names — what AnimationMixer must be given. */
  clips: string[];
  /** Human-readable clip names. */
  clipLabels: string[];
  abilities: Ability[];
  rigged: boolean;
  retired: boolean;
  retiredReason?: string;
  usage: ModelUsage;
}

type AbilityRow = { clips: string[]; skins: number };
const ABILITIES = abilitiesJson as Record<string, AbilityRow>;
const PARTS = partsJson as Record<string, string[]>;
/** Deliberately the SAME pattern as the census that generates the file — if the
 *  two drifted, the tab would promise a spinnable part the data never marked. */
const SPINNABLE_RE = /wheel|tyre|tire|rotor|blade|propeller|prop\b|turbine|fan|track|axle/i;

function buildUsage(name: string, clips: string[], size?: readonly number[], facing?: string, realSize?: readonly number[]): ModelUsage {
  // placeModel is the line a game should actually copy (restored 2026-08-23):
  // it grounds, sizes and aims in one call. The bare loadModel form stays
  // below it for a model we know nothing about.
  if (facing || realSize) {
    const known = [facing ? `faces ${facing}` : null, realSize ? `${realSize.map((n) => n.toFixed(2)).join(" x ")} m in real life` : null]
      .filter(Boolean)
      .join(", ");
    return {
      marker: `<!--USES_MODELS: ${name}-->`,
      load:
        `// ${known}\n` +
        `const m = await placeModel("${name}", { at: { x: 0, z: 0 }${realSize ? ", metres: true" : ""} });\n` +
        `scene.add(m); // stands on the ground, back to the player — you still add it\n` +
        `// steering, every frame:  m.rotation.y = modelHeading("${name}", heading);`,
      ...(clips.length
        ? {
            animate:
              `const mixer = new AnimationMixer(m);\n` +
              `const clip = m.animations.find(a => a.name === ${JSON.stringify(
                clips.find((c) => /(^|_)walk/i.test(shortClip(c))) ??
                  clips.find((c) => /(^|_)(gallop|fly|swim|run)/i.test(shortClip(c))) ??
                  clips[0]!,
              )});\n` +
              `mixer.clipAction(clip).play();\n` +
              `// then, every frame:  mixer.update(delta);`,
          }
        : {}),
    };
  }
  const load = size
    ? `const m = await loadModel("${name}");\n// real size at scale 1: ${size.map((n) => n.toFixed(2)).join(" x ")} m\nconst [w, h, d] = modelSize("${name}");\nscene.add(m);`
    : `const m = await loadModel("${name}");\nscene.add(m); // skinned mesh — scale by eye, modelSize is not meaningful`;

  if (clips.length === 0) return { marker: `<!--USES_MODELS: ${name}-->`, load };

  // Prefer a locomotion clip for the example — it is what a game usually wants
  // first — but fall back to whatever exists rather than inventing one.
  const pick =
    clips.find((c) => /(^|_)walk/i.test(shortClip(c))) ??
    clips.find((c) => /(^|_)(fly|flying|swim)/i.test(shortClip(c))) ??
    clips[0]!;

  return {
    marker: `<!--USES_MODELS: ${name}-->`,
    load,
    animate:
      `const mixer = new AnimationMixer(m);\n` +
      `// exact clip name, armature prefix and all:\n` +
      `const clip = m.animations.find(a => a.name === ${JSON.stringify(pick)});\n` +
      `mixer.clipAction(clip).play();\n` +
      `// then, every frame:  mixer.update(delta);`,
  };
}

export function modelCatalogue(manifest: AssetManifest = manifestJson as AssetManifest): ModelCapability[] {
  return manifest.assets
    .filter((a) => a.type === "model")
    .map((a) => {
      const row = ABILITIES[a.name] ?? { clips: [], skins: 0 };
      const tax = TAXONOMY[a.name];
      const clips = row.clips ?? [];
      return {
        name: a.name,
        displayName: a.name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()),
        url: a.url,
        bytes: a.bytes,
        license: a.license,
        ...(a.author ? { author: a.author } : {}),
        sourceUrl: a.sourceUrl,
        ...(a.size ? { size: a.size as [number, number, number] } : {}),
        ...(a.facing ? { facing: a.facing } : {}),
        ...(a.realSize ? { realSize: a.realSize as [number, number, number] } : {}),
        genres: tax?.genres ? [...tax.genres] : [],
        tags: tax?.tags ? [...tax.tags] : [],
        parts: PARTS[a.name] ? [...PARTS[a.name]!] : [],
        spinnable: (PARTS[a.name] ?? []).filter((p) => SPINNABLE_RE.test(p)),
        clips,
        clipLabels: clips.map(shortClip),
        abilities: deriveAbilities(clips),
        rigged: (row.skins ?? 0) > 0 || clips.length > 0,
        retired: RETIRED.has(a.name),
        ...(RETIRED.has(a.name) ? { retiredReason: RETIRED_MODELS[a.name] } : {}),
        usage: buildUsage(a.name, clips, a.size, a.facing, a.realSize),
      };
    });
}
