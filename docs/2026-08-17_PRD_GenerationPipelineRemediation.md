# 2026-08-17 — Generation Pipeline Remediation

**Status:** BUILT 2026-08-17 (same day). All P0 done, all P1 done or instrumented,
P2 still awaiting owner decisions. Nothing deployed — awaiting the owner's word.

| Item | Outcome |
|---|---|
| A1 controls inverted | ✅ `ONE INPUT INTENT, ONE OUTCOME` in BOTH contracts |
| A2 nothing renders before Start | ✅ `DRAW EVERY FRAME` in BOTH contracts |
| A3 `batch.mesh.name` always `""` | ✅ `container.name = name`, batch version 2→3 |
| A4 buildings not injected | ✅ ROOT-CAUSED (stripped marker) + prompt's missing converse rule |
| B1 repair 1st attempt 0/5 | ✅ contract aligned with the rung that works — **hypothesis, stated as one** |
| B2 repairs not persisted | ⚠️ NOT root-caused — instrumented instead, deliberately (see below) |
| B3 probe only checks Start | ✅ new `controls_occluded` code + repair instruction |
| B4 `RUNTIME_GLOBALS` drift + heal-after-lint | ✅ one shared list, both directions tested; lint now reads healed HTML |
| B5 no correlation id | ✅ became a full logging system (owner ask mid-session) — `docs/LOGGING.md` |
| B7 golden runner single-turn | ✅ two-turn mode with a mechanical model-swap diff |
| B6 / C1 / C2 | ⏸ owner decisions — unchanged, see below |

**2,828 tests pass, typecheck clean.** New KNOWN_BUGS rows opened by this work: **#27**
(verify now ghost-clicks Start on healthy games — a real cost, watch it against the WebGL
context budget) and **#26** (published-game error capture, privacy decision first).

**B2 deliberately not "fixed".** This doc said "root-cause it, do not guess", and static
reading could not settle it — the persistence path exists and looks correct. So instead
`PUT /api/chats/:id` now logs `stage=persist chars=` under the same `trace=` as the repair's
`stage=deliver outChars=`. One grep will say whether the write never arrives, arrives stale,
or is overwritten. Leading suspect recorded in KNOWN_BUGS #24, unproven.


---

## Golden run, 2026-08-17 — the first two-turn run, and what it found

13 builds + 3 edit turns through the real pipeline, then all 16 games loaded in a
real browser. **14/16 run clean.** Full results in `golden/runs/`.

**The two-turn mode works.** No unrequested model swaps in any of the three edit
turns (models 2→2, 6→6, 3→3) — the aeroplane→spaceship class did not reproduce.
It flagged two real faults on its own:

```
editing city-roads      … models 2→2   ⚠ the edit added NO new model
editing village-scenery … models 3→3   ⚠ the edit added NO new model
```

That is now KNOWN_BUGS #28 — and it is the owner's ORIGINAL complaint still
reproducing, but for a different reason than the plumbing bugs fixed today.

**Three faults it surfaced, all newly filed:**

| | |
|---|---|
| #28 | "add cars and bikes" / "add tall buildings" add no model — generation quality, not plumbing (the toy box *is* sent on edit turns; the names *were* available) |
| #29 | `THREE.Object4D is not a constructor` — a hallucinated member on a NAMESPACE import, which the import lint deliberately ignores |
| #30 | A game invented `https://assets.mixkit.co/models/crocodile.glb` → 403; nothing lints a model URL handed to a loader |

**And three lint faults, which the new logging made countable in one command:**
`PCFSoftShadowMap` ×2, `FogExp2` ×1 — each a ~30s corrective regeneration, and
each a contradiction we created (the prompt tells the model to enable shadows and
mentions fog; neither constant was exported).

### Pending: the shadow/fog constants

Recipe updated (`scripts/vendor-three.mjs`), built and measured: **622 KB, +1 KB,
budget 650**. NOT yet published — the lockstep test enforces recipe-first,
upload-second, teach-third, so nothing is taught until the bundle is live.

**Owner runs:**
```
node --env-file=../Ariantra-Platform/.env scripts/vendor-three.mjs --upload
```
Append-only and content-hash named, so it can never overwrite `three.4baa3a.js`.

**Then, and only then, the follow-up (3 steps):**
1. Add `PCFSoftShadowMap`, `PCFShadowMap`, `BasicShadowMap`, `VSMShadowMap`,
   `FogExp2` to `CURATED_IMPORT_NAMES` in `prompt-catalog.ts`.
2. Raise the `modelsPromptSection` token ceiling (~50 tokens, owner-approved
   2026-08-17) and record the reason in the test's own history comment — that
   comment currently says "THE NEXT RAISE SHOULD NOT HAPPEN", so it must be
   updated honestly rather than quietly stepped over.
3. `npx vitest run` — `curated-imports.test.ts` is what proves the names are
   genuinely served before they are ever taught.

---

**Original plan below, unchanged.**

**Origin:** one owner report ("the aeroplane changed") that opened into eleven
distinct faults, found by reading production logs live during a real session and
then reading the actual generated game HTML.

**How to use this doc:** it is written to be picked up COLD. Every item carries
its evidence, the file it lives in, and what "done" means, so no investigation
needs repeating. Work top-down: P0 first.

---

## 0. Already shipped today — do NOT redo

| Commit | What |
|---|---|
| `6ef728f` | `loadModelBatch` names now reach `AR_ASSETS` (the missing cars); unrequested-model-swap gate; "cartoonish" removed from every live prompt |
| `171a50d` | Swap gate moved to advisory on the cheap strict rung (blocking there cost a child their whole edit) |
| `9d1a77a` | `pointer-events` rules in build AND edit contracts; `repairFaultLine()`; `formatRepairErrorSummary()` |
| `99b93f7` | Owner published the three bundle (`three.4baa3a.js`, 621 KB); `CatmullRomCurve3` + `TubeGeometry` now served and taught |

Live and verified on the box. Rollback point: `git checkout 9d1a77a && npm run deploy` (from the **Game** repo — `deploy:all` exists only in the platform repo).

**Unproven:** that an *informed* repair actually succeeds. One post-fix repair
produced +86 chars vs the +10/+12 no-ops before it — encouraging, not proof.
Confirmation = `start_occluded` fires once and does NOT recur on the repair's
own output.

---

## Tech Feasibility

Every P0 item is a deterministic string/runtime change or a prompt rule with a
pin test — the same shapes already shipped today, no new infrastructure.

The two genuinely uncertain items are called out as such and neither is P0:
- **B1 (building models)** — root cause NOT yet established. Needs investigation
  before a fix is designed. Do not skip to a fix.
- **D2 (published-game error capture)** — blocked on a privacy decision, not on
  engineering.

The riskiest change is **A3** (`container.name`), because it touches a runtime
helper that ~200 stored games call. It is additive (sets a currently-empty
field) and gated behind a version bump, which is the mechanism already used for
`LOAD_MODEL_HELPER_VERSION` / `PERF_PROBE_VERSION`.

---

## Tech Plan

### P0 — from the owner's actual game HTML (all verified in source)

#### A1. Flight controls are inverted, and the keyboard contradicts the buttons
**Evidence** (owner's `Mumbai Flight Sim`):
```js
const targetPitch = (keys['ArrowUp'] || keys['KeyW'] || btns.down) ?  0.6
                  : (keys['ArrowDown']|| keys['KeyS'] || btns.up)  ? -0.6 : 0;
```
`rotation.x = pitch`, forward `(0,0,1)` → positive pitch gives `y = -sinθ`, i.e.
**descend**. So the DOWN button descends (correct) while ArrowUp also descends
(inverted). Same defect on yaw: `ArrowLeft` → `roll = +0.8` → `rotation.y`
decreases → nose toward −X, which is **screen right** when the camera looks
along +Z (`right = forward × up = (0,0,1)×(0,1,0) = (-1,0,0)`).

This is the owner's "I am not able to move up or down" and "the left right and
the up down dont work right" — reported repeatedly and never fixed, because
every attempt treated it as a handler bug.

**Fix:** a build/edit contract rule — one input intent maps to one outcome; the
keyboard and the on-screen buttons for the same action MUST set the same value,
and "up" must move the thing up on screen. Prefer a single
`input.pitchUp`-style intent object that both bind into, so they cannot diverge.

**Test:** pin the rule in both contracts (mirror `gemini.pointer-events.test.ts`,
including the `isEdit` variant — that is the case that failed first last time).

#### A2. Nothing renders before the game starts
```js
function animate() {
  requestAnimationFrame(animate);
  if (!gameStarted) return;     // ← renderer.render() is BELOW this
  ...
  renderer.render(scene, camera);
}
```
Canvas is blank behind the start screen. Also a likely contributor to
verify-probe confusion (a game that draws nothing is not obviously distinct from
a broken one).

**Fix:** contract rule — the render call runs EVERY frame; only the SIMULATION
is gated by game state. Test: pin the rule.

#### A3. `batch.mesh.name` is always `""`, so per-type logic is dead
`loadModelBatch` returns `{ mesh: container }` where `container = new Group()`
— `.name` is `""`. Generated games reasonably branch on it:
```js
if (e.batch.mesh.name === 'bird') batchScale = 0.5;          // never true
if (e.batch.mesh.name.includes('tree')) batchScale = 5.0;    // never true
```
Every moving batch was forced to one scale each frame.

**Fix:** `container.name = name;` in `loadModelBatchHelper()`
(`src/lib/assets/runtime-helpers.ts`). Bump `LOAD_MODEL_BATCH_VERSION` 2 → 3 so
`ensureAssetRuntime` re-floors stored games (same mechanism as the perf-probe
version). Cheap, additive, high leverage.

**Test:** unit-test that a batch's container carries the model name; add a
stored-game re-floor case.

#### A4. Building models are not injected at all — ROOT CAUSE UNKNOWN
The owner's city is 600 `BoxGeometry` instances plus hand-built glowing "window"
boxes. `AR_ASSETS` contains **no** `skyscraper` / `office_building` /
`apartment` / `shop`, though an earlier version of the same game used all four.
The model then hand-rebuilt window bands — the same instinct behind it reaching
for `CanvasTexture` (see C1).

Confirmed NOT the cause: the GLB is fine (`skyscraper.b6fb82.glb` has material
`colormap` with a `baseColorTexture` and `TEXCOORD_0` UVs); the served bundle
decodes textures (`baseColorTexture`, `KHR_texture_transform`, `ImageBitmap`,
`GLTFLoader` all present); `loadModelBatch` v2 preserves each part's material.

**Do the investigation first.** Candidate explanations, in order:
1. An edit dropped the `loadModel("skyscraper")` call sites, so injection had
   nothing to reclaim (the swap lint now logs exactly this — check for
   `⚠ strict rung drops models` / `⛔ patch drops models` naming a building).
2. The model chose primitives over the library because nothing tells it to
   PREFER a library model for a thing the library has.
3. Marker loss across an edit chain (`inSource=false` / `reconcileBailed`).

**Likely fix** (pending the above): a contract rule — if the toy box has the
thing, use the model; hand-built primitives are for what the library lacks. Plus
the rule that a loaded model arrives pre-painted: tint via `material.color` or
clone-and-modify, never replace the material.

---

### P1 — instrumentation and the self-heal (from live monitoring)

#### B1. The repair's FIRST attempt never produces a patch — 5 of 5
Every observed repair logged `rescued by strict retry (first: no_patch_in_reply)`.
The first call is a wasted model call (~3s + Sparks) on every single repair.
`repair-prompt.ts`'s `REPAIR_SYSTEM_PROMPT` is the suspect. Testable offline
against a captured occluded game — no browser needed. KNOWN_BUGS #23(b).

#### B2. Repairs are not persisted — KNOWN_BUGS #24
Stored source stayed frozen at `60,543` across two edits while repairs produced
`60,531` and `60,282`; later frozen at `70,718` while repairs produced `71,955`.
Repair #1 of the session DID persist (`58,895` was picked up by the next edit),
so this is CONDITIONAL — root-cause it, do not guess.

#### B3. The occlusion probe only hit-tests the START button
`preview-verify.ts` checks one element. An overlay covering take-off/land or
up/down is never detected. Extend to the on-screen control buttons.

#### B4. `RUNTIME_GLOBALS` drift + healer runs after the lint — KNOWN_BUGS #21
`three-import-lint.ts`'s `RUNTIME_GLOBALS` omits `placeModel`, `modelHeading`,
`modelFacing` (all genuinely injected — see `runtime-helpers.ts`), while
`strip-runtime.ts` lists them: two copies that have drifted, want one shared
source. And `stripRuntimeGlobalImports` runs inside `toDeliverable`, AFTER the
lint reads the raw artifact — so the healer never prevents the ~50s corrective
retry it was written to retire. Cost seen live: `⛔ unknown three imports:
loadModel, placeModel, modelHeading — corrective retry @71804ms`.

Also seen: `ariantra` and `/utils/three-loader.js` as invented module
specifiers. Teach or heal alongside.

#### B5. No correlation ID in any log
Nothing ties a chat turn to its repair. Today that was done by matching
character counts by eye — workable with one user on the box, guesswork with ten.
Cheap to add, makes every future investigation legible.

#### B6. `isRepeatedRequest` is exact-match — KNOWN_BUGS #20
Requires a word-for-word identical PREVIOUS message. Measured against the
owner's four real re-asks: **fired 0 of 3**. So `REPEATED_REQUEST_SECTION`, the
one mechanism for "your last fix didn't work", never reached the model.
**Needs an owner decision** — widening it risks telling the model a good fix
failed.

#### B7. The golden runner is single-turn — KNOWN_BUGS #19
Cannot express build→edit, which is where most of today's bugs live. Wants a
two-turn mode that diffs `loadedModelNames()` before/after so an unrequested
swap is a number, not a judgement.

---

### P2 — owner decisions (do not start without an answer)

#### C1. Texture exports — KNOWN_BUGS #25
**Zero** of the 40 published exports are texture-related. `CanvasTexture` +
`RepeatWrapping` is the standard way to give a building windows, so "make the
buildings look right" is structurally unsatisfiable. Blocked on: the bundle is
**621 KB against a 650 KB budget**, and shipping means an authorised
`PutObject` to `assets.ariantra.com`.

#### C2. Published games have NO error capture
`injectConsoleCapture` is wired only into `ArtifactFrame.tsx` (preview) and
`preview-verify.ts`. Once a game is published and a real child plays it, nothing
is captured — no console, no errors, no self-heal. **Raise as a privacy question
first:** it means collecting data from children's sessions.

---

## Use Cases (every one, and how we tackle it)

| # | Use case | How this plan tackles it |
|---|---|---|
| 1 | Child presses UP and the plane goes up | **A1** — one intent, one outcome; keyboard and buttons cannot diverge |
| 2 | Child presses a button and anything at all happens | Shipped (`pointer-events`) + **B3** so gameplay controls are checked, not just Start |
| 3 | Child asks for a city and gets buildings that look like buildings | **A4** (use the library model) + **C1** (textures) |
| 4 | Child asks for "lots of cars" and sees cars | Shipped (`loadModelBatch` healing) |
| 5 | Child's plane stays their plane across edits | Shipped (swap gate) |
| 6 | Child's game does not silently lose a prop on a rescue | Shipped (advisory rung) — the log now counts how often |
| 7 | Child sees something on screen before pressing Start | **A2** |
| 8 | A game that breaks gets genuinely repaired | **B1** (first attempt) + **B2** (persistence) + shipped `repairFaultLine` |
| 9 | A game does not crash on an import the bundle lacks | Shipped (bundle published) + **B4** (heal before lint) |
| 10 | Owner can ask "why did this get worse?" and get an answer | **B5** (correlation id) + shipped `err=` logging |
| 11 | Child re-asks for the same thing and is not told "done!" again | **B6** — owner decision |
| 12 | A build→edit regression is caught before the owner sees it | **B7** |
| 13 | A real child hitting a bug in a PUBLISHED game is visible to us | **C2** — privacy decision first |

---

## Build order

1. **A3** — `container.name` (smallest, unblocks per-type logic immediately)
2. **A1 + A2** — control-intent and render-every-frame rules, both pinned in build AND edit contracts
3. **A4** — investigate, report the cause, then fix
4. **B4, B5** — contained, high leverage
5. **B1, B2, B3** — the self-heal
6. **B7** — the instrument that would have caught most of this
7. Stop and re-raise **B6, C1, C2** for decisions

## Rules for this work
- Test-first, and **watch the test fail** — `P.5` (the edit-contract case) caught
  a fix that would have shipped looking correct and done nothing.
- Every prompt rule pinned in BOTH the build and edit contracts. Edit turns get
  the slimmed `GAME_EDIT_CONTRACT`; a rule added only to `GAME_BUILD_CONTRACT`
  does not reach the case where most faults are introduced.
- Nothing ships without the owner's word. Deploy from the Game repo with
  `npm run deploy`.
- Update `BUG-FIX-LOG.md` / `KNOWN_BUGS.md` in the same change.

## Housekeeping
A production log monitor may still be running (`TaskStop` on the monitor task).
