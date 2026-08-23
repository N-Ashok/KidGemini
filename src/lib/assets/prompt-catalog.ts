// The 3D + model-catalog (and, from Phase D, audio) sections of the
// game-build system prompt (PRD-3D-GAMES-AND-ASSETS Part I, §5b, §7). Kept
// beside the manifest because catalog names and budgets must version-lock
// with it — prompt-catalog.test.ts pins the import list to the vendored
// bundle's exports, the render-budget rules to §7, and the model names to
// the manifest. Pure strings, no I/O (the manifest is a static import).

import type { ChatMessage } from "@/types/chat.types";
import type { AssetManifest } from "./manifest";
import manifestJson from "./manifest.json";
import { modelsInGenre } from "./asset-taxonomy";
import { GENRES, peopleModels, selectModelNames, soldierModels } from "./model-select";
import { offerable } from "./retired";
import type { ThreeUnlockReason } from "./catalog-gate";

/**
 * The sports playbook (owner ask 2026-07-26): without it the model writes the
 * "every player swarms the ball" game. Rules + team-AI pattern in ~250 tokens.
 * CACHE CONTRACT: this clause depends only on the MANIFEST (renders when the
 * sports genre has members), never on the child's message — so the section
 * stays byte-identical per turn and Gemini prefix caching keeps hitting
 * (COST_TOKEN_BUDGET.md waste-ledger #4; same rule as the people clause).
 */
const SPORTS_PLAYBOOK = `
   Sports games have RULES — build them in, don't just scatter the models:
   For a TEAM SPORT (football/soccer, hockey, polo, handball): two teams score
   by getting the ball (or puck) into the OPPONENT's goal; after a goal show
   the score and restart everyone at their starting spots at the centre; first
   to 3 goals (or a short timer) wins. Do NOT make every player chase the
   ball: give each player a role and a home spot in formation, and each frame
   only the ONE teammate closest to the ball chases it (play "sprint");
   everyone else eases toward home + (ball - home) * 0.2 so the team keeps its
   shape. The goalkeeper is clamped to the goal mouth and only tracks the
   ball's sideways position. When the chaser reaches the ball, play the kick
   clip (the footballers carry attack-kick-right/left; for a hockey/polo hit
   use "interact-right") and push the ball with a velocity impulse toward the
   opponent's goal; multiply the ball's velocity by ~0.98 each frame so it
   slows by friction — no physics engine. The pitch is a green plane with a
   goal at each end.
   For a DUEL game (air hockey, pong-style, battle tops): no formations — two
   players and simple physics (velocity + bounce off the walls + friction).
   Air hockey: each paddle stays clamped to its own half; the computer paddle
   tracks the puck at a capped speed so the kid can win. Battle tops: spin
   with rotation.y += speed * delta and let speed decay slowly; when tops
   collide, bounce them apart and let each steal a little of the other's
   spin — the top that runs out of spin first wobbles and loses.`;

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
  // 2026-07-29 — see the note in scripts/vendor-three.mjs: the model kept
  // reaching for these and crashing on the import line.
  "Quaternion", "Euler", "Matrix4", "Vector2", "MathUtils", "Raycaster",
  // 2026-08-10 (AutoRicksaw, 1,250 draws/frame): the draw-call slowdown hint
  // prescribes instancing for hand-built scenery. The served bundle has
  // ALWAYS exported InstancedMesh (it backs loadModelBatch) — only this list
  // blocked it, which is how a correct fix patch got rejected and a child's
  // 89-message game was regenerated away. Placement composes via Matrix4
  // (already taught) — Object3D/DynamicDrawUsage stay unvendored.
  "InstancedMesh",
];
const CURATED_IMPORTS = CURATED_IMPORT_NAMES.join(", ");

// The 3D section has TWO lead-ins and ONE body (2026-08-23). The body — the
// marker, the curated imports, the single canvas, the lighting rig, the draw
// budget — is identical either way: it is how to build in 3D, not whether to.
//
// The lead-in is the part that must differ. `asked` is byte-for-byte the
// wording that shipped before this split (the prompt-pin tests hold it), and
// it is emphatic because the child literally typed "3D": a flat canvas dressed
// up to look 3D is the #1 way that request goes unmet. `subject` is for a turn
// unlocked by what the game is ABOUT (catalog-gate.ts's THREE_SUBJECT_GENRES)
// — the child never asked, so it OFFERS 3D and names the real reason it is
// usually the better answer, while naming the flat games that must stay flat.
// Handing the `asked` wording to a subject unlock would build a spelling quiz
// in Three.js.
const THREE_LEAD_ASKED = `**3D graphics**: this child asked for 3D — so build a REAL 3D scene with
Three.js and a PerspectiveCamera. Do NOT fake it with a flat 2D canvas, CSS
3D transforms, or sprites scaled to look far away: a 2D canvas dressed up to
"look 3D" is the single most common way a 3D request goes unmet — the child
keeps saying "this isn't really 3D" and they are right. Anything they call a
"3D game", "3D cars", a "3D world", or "real 3D" MUST be Three.js. (Only a
game that is genuinely better flat — a quiz, a word game, a 2D board game —
should stay 2D, in which case skip the marker below.) To build in 3D:
`;

const THREE_LEAD_SUBJECT = `**3D graphics**: this game is about a real thing — a creature, a vehicle, a
place — and the ready-made 3D models listed below are almost always a better
answer than drawing that thing by hand. A horse built from the rigged \`horse\`
model looks like a horse and gallops; a horse drawn on a flat 2D canvas out of
a filled rectangle, two stroked legs and a dot for an eye looks like a block
diagram, and the child sees that immediately. So unless this game is one of
the kinds that is genuinely BETTER FLAT — a quiz, a word or spelling game, a
2D board or card game, a drawing or colouring game, a simple tapping game —
build a REAL 3D scene with Three.js and a PerspectiveCamera and use the models
below for the things in it. If it IS better flat, stay 2D and skip the marker
below; that is a real choice, not a fallback. Either way never FAKE 3D with a
flat canvas, CSS 3D transforms, or sprites scaled to look far away. To build
in 3D:
`;

const THREE_BODY = `1. Put the single line \`<!--USES_THREE-->\` as the very first thing inside
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
   phones, tablets and Chromebooks.
7. Keep the OBJECT COUNT low too — every separate Mesh is a draw call, and a
   few hundred of them (window strips, fence posts, crowd pieces) makes any
   game stutter no matter how simple each one is. When you need MANY copies
   of the same shape, build ONE \`InstancedMesh(geometry, material, count)\`
   and place each copy with
   \`im.setMatrixAt(i, new Matrix4().setPosition(x, y, z))\` (compose with
   Quaternion/scale via \`new Matrix4().compose(pos, quat, scale)\` if a copy
   needs rotation), then \`im.instanceMatrix.needsUpdate = true\`. One
   InstancedMesh = one draw call for ALL its copies. Aim for under 150 draw
   calls in the scene.`;

/** The 3D section for this turn. Defaults to the `asked` lead-in, so every
 *  existing caller and every prompt-pin test sees the exact text it did before
 *  the split. */
export function threePromptSection(reason: ThreeUnlockReason = "asked"): string {
  return (reason === "subject" ? THREE_LEAD_SUBJECT : THREE_LEAD_ASKED) + THREE_BODY;
}

/** The pre-2026-08-23 constant, unchanged byte-for-byte. Kept as the name the
 *  prompt-contract tests and the default gates path already import. */
export const THREE_PROMPT_SECTION = threePromptSection("asked");

/**
 * THE CATEGORY MAP (2026-08-09, the hybrid this file's §5b note has promised
 * since 2026-07-24 and three ceiling raises have deferred).
 *
 * Headings and COUNTS, no names. Measured before the animals/snow batch: the
 * section was 2,522 tokens = 1,802 prose + 720 names (264 models at ~2.7
 * tokens each), and names are the half that grows without bound as the library
 * does. The exact names now travel per-turn at the END of the request contents
 * (retrievedModelNames + modelNamesBlock below), which is what keeps this
 * section byte-stable per manifest and the Gemini prefix cache hitting.
 *
 * The counts are load-bearing, not decoration: they are what stops the model
 * designing a pizza restaurant out of hand-rolled cubes because this turn's
 * retrieved list happened not to mention food (the 2026-07-24 regression).
 * They say "19 food models exist" even when none are named this turn.
 */
function categoryCountLines(available: Set<string>): string {
  const claimed = new Set<string>();
  const lines: string[] = [];
  for (const genre of GENRES) {
    const names = modelsInGenre(genre.id, available).filter((n) => !claimed.has(n));
    if (names.length === 0) continue;
    for (const n of names) claimed.add(n);
    lines.push(`   - ${genre.label}: ${names.length}`);
  }
  const orphans = [...available].filter((n) => !claimed.has(n));
  if (orphans.length > 0) lines.push(`   - other: ${orphans.length}`);
  return lines.join("\n");
}

/**
 * The per-turn name list: the retrieval half of the hybrid. Pure function of
 * the child's words + the game being edited + the manifest, so it is cheap,
 * testable and deterministic.
 *
 * Deliberately GENEROUS. The regression this must not reintroduce is the one
 * that killed per-message selection in 2026-07-24: a child saying "make me a
 * fun game" triggered no genre, was taught 6 of 106 models, and hand-rolled
 * cubes while 19 food models sat unused. Guards, in order of what they fix:
 *   1. models the CURRENT GAME already uses — dropping one would make the
 *      model unable to keep its own game working (selectModelNames rule 1);
 *   2. every genre the child's words trigger, whole;
 *   3. names the child said outright;
 *   4. a BROAD DEFAULT SPREAD when nothing triggers — a few from every single
 *      category, so "a fun game" still sees the whole shape of the library;
 *   5. the core basics last.
 */
export function retrievedModelNames(input: {
  message: string;
  history: ChatMessage[];
  manifest?: AssetManifest;
}): string[] {
  const manifest = input.manifest ?? (manifestJson as AssetManifest);
  // offerable(): the genre spread tops up from every category, so without this
  // a retired model would come straight back in through the spread even though
  // selectModelNames refused it (retired.ts).
  const available = new Set(
    offerable(manifest.assets.filter((a) => a.type === "model").map((a) => a.name)),
  );
  const picked = new Set(selectModelNames({ ...input, manifest }));

  // The spread: whatever selection found, top up with a sample from every
  // category so no category is ever invisible. Sampled from the FRONT of each
  // genre in taxonomy order — a stable, reviewable choice, not a random one.
  for (const genre of GENRES) {
    const names = modelsInGenre(genre.id, available);
    if (names.some((n) => picked.has(n))) continue; // already represented
    for (const n of names.slice(0, SPREAD_PER_GENRE)) picked.add(n);
  }
  return [...picked];
}

/** How many names per otherwise-unrepresented category ride in the spread.
 *  Measured at 8: a no-trigger turn ("make me a fun game") lands ~90 names /
 *  ~250 tokens, against the 640 tokens the hybrid took OUT of the system
 *  prompt — so even the broadest turn is cheaper than before, and the block
 *  lands AFTER the cached prefix so it never costs the game-code cache a hit.
 *  Deliberately generous rather than minimal: the failure this guards against
 *  (2026-07-24, a pizza restaurant hand-rolled out of cubes while 19 food
 *  models sat unused) is SILENT — nobody reports the game that could have been
 *  better — so the cheap side of the trade is the safe side. */
export const SPREAD_PER_GENRE = 8;

/**
 * Renders the retrieved names as the block that rides at the END of the
 * request contents — after the history and the child's message, never inside
 * the system instruction.
 *
 * WHY THE END, precisely. Gemini implicit caching matches the longest common
 * PREFIX. Request N is [system][history][message N][names N]; request N+1 is
 * [system][history + reply N][message N+1][names N+1]. The common prefix runs
 * through message N — which means the whole system instruction AND the
 * 10–15k tokens of repeated game code in the history stay cached
 * (COST_TOKEN_BUDGET.md waste-ledger #4, the exact cost this file's 2026-07-24
 * note refused to pay). The only thing that ever misses is the small block
 * itself. That is the entire reason the names moved here rather than staying
 * in a system prompt that would have had to vary per message.
 */
export function modelNamesBlock(names: readonly string[]): string {
  if (names.length === 0) return "";
  return `(Toy box — the model names you may use on THIS turn: ${[...names].sort().join(", ")}. Only these; never invent a name.)`;
}

/**
 * The named model catalog (§5b) — generated from the manifest so the names the
 * prompt teaches are exactly the names the injector can resolve. Empty string
 * when there is nothing to teach.
 *
 * Teaches the WHOLE library, grouped by category, and deliberately does NOT
 * vary with the child's message (2026-07-24). Two reasons, both load-bearing:
 *
 * 1. Correctness. Selection ran on the CHILD's words, but this catalog is
 *    consumed by the LLM's DESIGN decisions, which happen afterwards. A child
 *    saying "make me a fun game" triggered no genre, so the model was taught 6
 *    of 106 models, then hand-rolled cubes for a pizza restaurant while 19 food
 *    models sat unused. inject.ts resolves markers against the full manifest, so
 *    every name always worked — we simply were not telling the model they exist.
 * 2. Cost. A system prompt that varies per message breaks Gemini implicit
 *    caching on the whole append-only prefix behind it, including ~10-15k tokens
 *    of repeated game code (COST_TOKEN_BUDGET.md waste-ledger #4). Byte-stable
 *    output is what lets that cache hit.
 *
 * The trade-off is that catalog tokens now grow with the library instead of
 * being capped. prompt-catalog.test.ts pins the ceiling; past it, fall back to a
 * category-map hybrid (headings + counts static, exact names retrieved).
 */
export function modelsPromptSection(
  manifest: AssetManifest = manifestJson as AssetManifest,
): string {
  const models = manifest.assets.filter((a) => a.type === "model");
  if (models.length === 0) return "";
  const available = new Set(models.map((m) => m.name));
  const people = peopleModels(available);
  const soldiers = soldierModels(available);
  // CC-BY models (manifest-derived, so the section stays byte-stable per
  // manifest — same cache contract as everything else here): the model must
  // know the platform adds the credit chip, so it neither removes it nor
  // wastes tokens re-implementing attribution.
  const attributed = models.filter((m) => m.license === "CC-BY-3.0").map((m) => m.name);
  const categories = categoryCountLines(available);
  const hasSports = modelsInGenre("sports", available).length > 0;
  return `**Ready-made 3D models**: for a 3D game you may ALSO use professional
low-poly models from the toy box. Here is what the toy box HOLDS, by category:
${categories}
The exact model NAMES you may use appear in a "Toy box —" line at the very end
of this conversation. Design your game around the categories above — if a
category has models, they exist even when this turn's list is short: ask for
what you need and use the names you are given.
1. Add a second marker line right after \`<!--USES_THREE-->\` naming ONLY the
   models you use, e.g. \`<!--USES_MODELS: ${models[0]!.name}-->\` (comma-separated;
   only names from that "Toy box —" line). NEVER invent a model name — an
   unlisted name silently loads nothing. If you need an object the toy box
   doesn't have, build it from the primitive shapes instead.
2. Load them with the built-in \`loadModel(name)\` helper — do NOT import a
   loader yourself. It returns a Promise of a ready-to-add object, or null
   if loading failed.
3. Start the game loop immediately with simple primitive placeholder shapes,
   and swap the real model in when it arrives — never use await before the
   first frame renders:
   \`loadModel("${models[0]!.name}").then((m) => { if (m) { m.scale.set(2, 2, 2); scene.add(m); player = m; } });\`
   If \`m\` is null, simply keep the placeholder — the game must keep working
   without the model.
4. \`placeModel(name, opts)\` puts a model in the world CORRECTLY — standing on
   the ground, at a believable size, pointing where you want. Prefer it over
   bare \`loadModel\` for anything you position:
   \`const car = await placeModel("car", { at: {x: 0, z: 10} });
    scene.add(car);   // placeModel positions it; YOU still add it to the scene
    const house = await placeModel("house", { at: {x: 8, z: 0}, metres: true });
    scene.add(house);\`
   \`at\` {x,z} · \`metres: true\` for real-world size · \`scale\` a multiplier ·
   \`y\` ground height · \`heading\` "+z"/"-z"/"+x"/"-x"/radians.
   LEAVE \`heading\` OUT and you get THE DEFAULT VIEW: standing on the ground,
   BACK TO THE PLAYER, facing away into the scene — what you want for anything
   the player follows, drives, rides or walks behind. Identical for every model
   however it was exported, so never guess a facing and never write a rotation
   to "turn it round" (\`rotation.y = Math.PI\` is the classic guess that lands a
   game driving backwards at its own camera). \`modelFacing(name)\` tells you how
   one was exported; null = unaudited.
   ONE exception: a model you PARENT to another (a rider onto a horse, a driver
   into a car) takes \`heading: 0\` — "no turn of your own" — so it inherits the
   direction of what it sits on. Without it the rider faces the camera while the
   horse runs the other way.
   STEERING, where placeModel cannot help because rotation is set every frame:
   \`m.rotation.y = modelHeading(name, heading)\`. With the usual
   \`pos.x += sin(h)*v; pos.z += cos(h)*v\`, heading 0 travels +Z.
   DRIVING/RIDING SETUP — get these four consistent or the game feels wrong
   even when each part looks right. Pick the heading convention first
   (\`pos.x += sin(h)*v; pos.z += cos(h)*v\`, so heading 0 travels +Z), then:
   (1) the mount or vehicle: \`rotation.y = modelHeading(name, h)\`;
   (2) the camera: BEHIND along travel — \`pos - (sin(h), 0, cos(h)) * back\`,
       raised a little, looking at it. Size \`back\` FROM THE MODEL, about 3-4
       lengths (\`modelSize(name).z * 3.5\`) — never a bare number like 12,
       which is a close chase in one game and a distant speck in another;
   (3) build the WORLD at that scale: a road is a few car-widths across, not 30;
   (4) controls: Up accelerates, Down brakes then reverses, Left/Right steer —
       never swapped.
   A RIDER on a mount: place the mount normally, the rider with \`heading: 0\`,
   then \`mount.add(rider)\` — seat offset from \`modelMetres\`, never by eye.
   TWO SIZES, don't mix them up. \`modelSize(name)\` = the model's own units as
   published, what it measures on screen at scale 1 — use it for SPACING by
   real footprint: \`const w = modelSize("house").x; place(i * w * 1.5);\`
   \`modelMetres(name)\` = how big the thing is in REAL LIFE — use it to decide
   how big it SHOULD be. NEVER guess a size or spacing. The catalog's units are
   not
   consistent between models (by \`modelSize\` alone a mountain is smaller than
   a car), so size a scene with \`metres: true\` or
   \`obj.scale.setScalar(modelMetres(n).y / modelSize(n).y)\`. Both null when
   unknown — then eyeball it.
   ROAD TILES do not have a facing — they have a RUN AXIS:
   \`modelAxis(name)\` gives it ("x"/"z"/"none"/null); kits differ and
   a square tile's size can't reveal it. Tile them edge-to-edge by stepping the
   footprint: \`const w = modelSize("road_straight").x; place(i * w);\`
   TRACKS: ONE kit (\`road_*\` OR \`race_track_*\`), every piece scaled by the
   SAME number. NEVER guess a rotation — name the directions the road LEAVES
   each cell and \`fitTile\` does it (a 2 m piece covers TWO 1 m cells):
   \`// corner with track to the north and east:
    t.rotation.y = fitTile("race_track_corner", ["-z", "+x"]);\`
   null = wrong PIECE there. \`modelJoins(n)\` = edges + lane width.
5. Some models carry NAMED animations in \`m.animations\` — don't blindly play
   \`m.animations[0]\`: it's often an idle pose, or even an attack, so picking
   it for a "running" character makes it look like it's attacking instead of
   running. Search by name for the action you actually want first:
   \`const clip = m.animations.find(a => /run|walk/i.test(a.name))
     || m.animations.find(a => /gallop|swim|fly|jump|attack/i.test(a.name))
     || m.animations[0];
   const mixer = new AnimationMixer(m); mixer.clipAction(clip).play();\`
   and call \`mixer.update(delta)\` in your loop (use a Clock for delta).
6. For MANY static copies of one prop (a forest, a city block), use
   \`loadModelBatch(name, count)\` — can return null like \`loadModel\`, check
   first. Add \`.mesh\` once, call \`.setInstance(i, { position, scale,
   rotation })\` per placement — PLAIN \`{x, y, z}\` numbers, never a
   \`THREE.Euler\`. Use \`.boundsAt(i)\`, not \`Box3().setFromObject\`, for
   collision. Animated models use \`loadModel\`.
7. If a model needs to move (walk, fly, spin) but has no matching clip in
   \`m.animations\` — never invent a clip name, and never ASSUME what it is made
   of. \`modelParts(name)\` lists the named parts it really carries (null =
   none). ASK IT FIRST: nearly every vehicle ships one node PER WHEEL, so turn
   the real ones — never bolt fake wheels on beside them:
   \`const w = car.getObjectByName("wheel-front-left");
    w.rotation.x -= speed * dt;   // spin; steer the front pair with .rotation.y\`
   No skeleton is involved: a wheel is rigid and merely rotates — a node
   transform. Skinning is only for a mesh that DEFORMS.
   Bones present (\`*Leg*\`/\`*Wing*\`)? Drive them: sine-wave the rotation from
   time/speed, ease to rest when still.
   ONLY when \`modelParts(name)\` is null does a lookup find nothing and a spin
   loop silently do nothing — THEN add your OWN thin primitive (rotor/wheel)
   parented onto the model and spin that.${people.length ? `
   The people models (${people.join(", ")}) all share the same clips: idle,
   walk, sprint (= run), sit, drive, pick-up, interact-right/left, die, and
   emote-yes / emote-no. For a cheering stadium crowd, sit or stand them on
   the grandstand and play "emote-yes" (add a tiny position.y bounce for
   excitement); "sprint" is the running clip, "walk" the walking one. For a
   crowd, call loadModel per person — cheap after the first load, animates
   independently. Give each its own AnimationMixer. To hold a prop, these
   models have NO hand bone — parent to the arm, not the root:
   \`(m.getObjectByName("arm-right") || m).add(prop)\`.` : ""}${soldiers.length ? `
   The soldier models (${soldiers.join(", ")}) do NOT have the people clips
   above — they carry Idle, Run, Run_Gun, Idle_Shoot, Jump, Wave, Death. Use
   Run for ALL movement (there is no walk clip). Names are armature-prefixed
   (\`CharacterArmature|Run\`), so match by search, never by exact string. Same
   mixer/clone rules as the people. Weapons are SEPARATE models — parent to
   the lower arm, not the root: \`(soldier.getObjectByName("LowerArm.R") ||
   soldier).add(gun)\`.` : ""}${attributed.length ? `
   Community-art models (${attributed.join(", ")}) come with an automatic
   small "🎨 art" credit chip the platform itself adds to the game — the
   artist's license requires it. Never remove, hide, cover, or re-implement
   the chip; leave the bottom-left corner clear of controls.` : ""}${hasSports ? SPORTS_PLAYBOOK : ""}`;
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
