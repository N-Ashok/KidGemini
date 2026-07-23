// The 3D + model-catalog (and, from Phase D, audio) sections of the
// game-build system prompt (PRD-3D-GAMES-AND-ASSETS Part I, §5b, §7). Kept
// beside the manifest because catalog names and budgets must version-lock
// with it — prompt-catalog.test.ts pins the import list to the vendored
// bundle's exports, the render-budget rules to §7, and the model names to
// the manifest. Pure strings, no I/O (the manifest is a static import).

import type { ChatMessage } from "@/types/chat.types";
import type { AssetManifest } from "./manifest";
import manifestJson from "./manifest.json";
import { GENRES, PEOPLE_MODELS, selectModelNames } from "./model-select";

/** Names the vendored engine bundle exports — MUST stay in lockstep with
 *  THREE_EXPORTS in scripts/vendor-three.mjs (pinned by test). Exported as
 *  an array so the server-side import lint (three-import-lint.ts) checks
 *  against the SAME list the prompt teaches. */
export const CURATED_IMPORT_NAMES = [
  "Scene", "PerspectiveCamera", "WebGLRenderer", "Clock", "Color", "Fog",
  "Group", "Vector3", "Box3",
  "BoxGeometry", "SphereGeometry", "ConeGeometry", "CylinderGeometry",
  "PlaneGeometry", "TorusGeometry", "CapsuleGeometry", "RingGeometry",
  "Shape", "ShapeGeometry", "DoubleSide",
  "MeshStandardMaterial", "MeshBasicMaterial", "Mesh",
  "AmbientLight", "DirectionalLight", "PointLight", "HemisphereLight",
  "AnimationMixer",
];
const CURATED_IMPORTS = CURATED_IMPORT_NAMES.join(", ");

export const THREE_PROMPT_SECTION = `**3D graphics**: this child asked for 3D — so build a REAL 3D scene with
Three.js and a PerspectiveCamera. Do NOT fake it with a flat 2D canvas, CSS
3D transforms, or sprites scaled to look far away: a 2D canvas dressed up to
"look 3D" is the single most common way a 3D request goes unmet — the child
keeps saying "this isn't really 3D" and they are right. Anything they call a
"3D game", "3D cars", a "3D world", or "real 3D" MUST be Three.js. (Only a
game that is genuinely better flat — a quiz, a word game, a 2D board game —
should stay 2D, in which case skip the marker below.) To build in 3D:
1. Put the single line \`<!--USES_THREE-->\` as the very first thing inside
   \`<body>\` — this is how the platform knows to make the 3D library
   available (leave it out ONLY for a genuinely 2D game; don't add it otherwise).
2. Write your game code in \`<script type="module">\`, and start it with
   \`import { ${CURATED_IMPORTS} } from "three";\` — only import names from
   this exact list, and only the ones you use; nothing else is available
   (no textures, no OrbitControls, no post-processing effects).
3. Put exactly ONE \`<canvas id="scene"></canvas>\` in your HTML and draw INTO
   it — create the renderer EXACTLY like this:
   \`const renderer = new WebGLRenderer({ canvas: document.getElementById('scene'), antialias: true, preserveDrawingBuffer: true });\`
   Pass that canvas so the renderer draws into it. Do NOT also call
   \`appendChild(renderer.domElement)\`, and do NOT add a second \`<canvas>\`: a
   leftover empty canvas covers the real one and the whole screen goes BLACK
   (the #1 "my 3D game is a black screen" cause). preserveDrawingBuffer: true is
   REQUIRED (the platform's health check reads pixels back; without it every
   frame reads blank). Then \`renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));\`
   so high-density phones don't render 9x the pixels.
4. Build the scene from the primitive shapes and solid colors above. Light
   it with exactly two lights — one AmbientLight (soft fill) plus one
   DirectionalLight (depth) — and no more than that; no shadows (never set
   castShadow/shadowMap) and no post-processing: they are the classic
   phone frame-killers.
5. Size the WebGLRenderer to its container on load AND on window resize
   (same responsive rule as canvas games — never a fixed pixel size), with
   the page itself at height:100dvh.
6. Keep the poly count low — a handful of primitives (repeat one shape for
   scenery rather than adding many distinct objects), so it stays smooth on
   phones, tablets and Chromebooks.`;

/** Per-genre model hints (Phase F): which toy-box models fit which game
 *  ideas. The genre → models data lives in model-select.ts (one source of
 *  truth with prompt selection). Each line renders only names actually being
 *  taught this turn — a hint can never mention an untaught model — and
 *  genres with nothing available disappear entirely. */
function genreHints(available: Set<string>): string {
  const lines = GENRES
    .map((g) => [g.label, g.models.filter((n) => available.has(n))] as const)
    .filter(([, names]) => names.length > 0)
    .map(([genre, names]) => `   - ${genre}: ${names.join(", ")}`);
  return lines.join("\n");
}

/** The chat turn a prompt is being built for — lets the model catalog select
 *  a per-message subset (retrieval-lite, PRD §14) instead of teaching the
 *  whole library. Without it, the full catalog is taught (tests, small
 *  libraries). */
export interface PromptTurnContext {
  message: string;
  history: ChatMessage[];
}

/**
 * The named model catalog (§5b) — generated from the manifest so the names
 * the prompt teaches are exactly the names the injector can resolve. With a
 * turn context, teaches only the retrieval-lite selection for that message
 * (≤ PROMPT_MODEL_CAP names). Empty string when nothing to teach.
 */
export function modelsPromptSection(
  manifest: AssetManifest = manifestJson as AssetManifest,
  context?: PromptTurnContext,
): string {
  let models = manifest.assets.filter((a) => a.type === "model");
  if (context) {
    const selected = new Set(selectModelNames({ ...context, manifest }));
    models = models.filter((m) => selected.has(m.name));
  }
  if (models.length === 0) return "";
  const names = models.map((m) => m.name).join(", ");
  const people = models.map((m) => m.name).filter((n) => PEOPLE_MODELS.includes(n));
  const hints = genreHints(new Set(models.map((m) => m.name)));
  return `**Ready-made 3D models**: for a 3D game you may ALSO use these
professional low-poly models from the toy box: ${names}.
1. Add a second marker line right after \`<!--USES_THREE-->\` naming ONLY the
   models you use, e.g. \`<!--USES_MODELS: ${models[0]!.name}-->\` (comma-separated;
   only names from the list above). NEVER invent a model name — an unlisted name
   silently loads nothing. If you need an object the list doesn't have, build it
   from the primitive shapes instead.
2. Load them with the built-in \`loadModel(name)\` helper — do NOT import a
   loader yourself. It returns a Promise of a ready-to-add object, or null
   if loading failed.
3. Start the game loop immediately with simple primitive placeholder shapes,
   and swap the real model in when it arrives — never use await before the
   first frame renders:
   \`loadModel("${models[0]!.name}").then((m) => { if (m) { m.scale.set(2, 2, 2); scene.add(m); player = m; } });\`
   If \`m\` is null, simply keep the placeholder — the game must keep working
   without the model.
4. Models load at their own natural size — set \`m.scale\` and \`m.position\`
   so they fit your scene.
5. Some models carry NAMED animations in \`m.animations\` — don't blindly play
   \`m.animations[0]\`: it's often an idle pose, or even an attack, so picking
   it for a "running" character makes it look like it's attacking instead of
   running. Search by name for the action you actually want first:
   \`const clip = m.animations.find(a => /run|walk/i.test(a.name))
     || m.animations.find(a => /gallop|swim|fly|jump|attack/i.test(a.name))
     || m.animations[0];
   const mixer = new AnimationMixer(m); mixer.clipAction(clip).play();\`
   and call \`mixer.update(delta)\` in your loop (use a Clock for delta).${people.length ? `
   The people models (${people.join(", ")}) all share the same clips: idle,
   walk, sprint (= run), sit, drive, pick-up, interact-right/left, die, and
   emote-yes / emote-no. For a cheering stadium crowd, sit or stand them on
   the grandstand and play "emote-yes" (add a tiny position.y bounce for
   excitement); "sprint" is the running clip, "walk" the walking one. For a
   crowd, call loadModel again for each person (the download is cached, so
   extras are free) — do NOT .clone() a person: cloned characters share one
   skeleton and animate wrong. Each person needs their own AnimationMixer.` : ""}${hints ? `
6. Good fits by game idea (use the ones that match, skip the rest):
${hints}` : ""}`;
}

/**
 * The named audio catalog (§5b) — generated from the manifest, same
 * lockstep-by-construction as the models. Works in 2D AND 3D games. Empty
 * string when the manifest has no audio (zero prompt tokens).
 */
export function audioPromptSection(manifest: AssetManifest = manifestJson as AssetManifest): string {
  const sfx = manifest.assets.filter((a) => a.type === "sfx").map((a) => a.name);
  const music = manifest.assets.filter((a) => a.type === "music").map((a) => a.name);
  if (sfx.length === 0 && music.length === 0) return "";
  const firstSfx = sfx[0] ?? music[0]!;
  return `**Real game sounds**: you may add professional sound effects and music
to ANY game (2D or 3D). Sound effects: ${sfx.join(", ") || "(none)"}.
Music: ${music.join(", ") || "(none)"}.
1. Add the marker \`<!--USES_AUDIO: ${firstSfx}-->\` as a line at the top of
   \`<body>\`, naming ONLY the sounds you use (comma-separated; only names
   from the lists above — anything else is ignored).
2. Play effects at game events with the built-in helper:
   \`playSound("${firstSfx}")\` — fire and forget, never awaited.
3. Start background music once, right after the game starts:
   \`playMusic("${music[0] ?? firstSfx}")\` — it loops seamlessly by itself
   and returns a handle with \`.stop()\`. Call playMusic at most once —
   never inside the game loop. Do NOT create your own Audio elements or
   AudioContext — the helpers handle loading, looping and the browser's
   tap-to-unmute rule.
4. Sounds are an extra, never a requirement: if a sound fails it is simply
   silent — the game must play fine without it (never block on audio).`;
}
