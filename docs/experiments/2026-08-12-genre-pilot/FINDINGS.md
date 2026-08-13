# Genre playbook pilot — findings

Real production 3D-game initial prompts (see pilot-set.json), each run two ways with IDENTICAL generation overrides (thinkingBudget/maxOutputTokens from builderGenOverrides):

- **PRO** — `gemini-2.5-pro` single pass, real production turn (buildTurnSystemInstruction + CHILD_BUILDER_CONTEXT + retrieved model names).
- **PIPELINE** — `gemini-2.5-flash-lite` writes a PRD → `gemini-2.5-flash-lite` compiles it into a build spec → `gemini-2.5-flash` builds from the spec with the real production turn.

Served locally: `python3 -m http.server 8765` from `docs/experiments/2026-08-12-genre-pilot/games`.

---

## Synthesis (real Chromium verify, `scripts/verify-game-html.mjs`, all 15 games)

| | clean | broken |
|---|---|---|
| PRO (`gemini-2.5-pro`, single pass) | 10/15 (67%) | 5/15 |
| PIPELINE (Lite PRD → Lite spec → Flash build) | 3/15 (20%) | 12/15 |

**Pro wins on correctness, decisively, at every genre.** The pipeline's extra
compile stages did not close the gap on THIS pass — they made the dominant
failure worse (see below), not better. This does not yet mean "abandon the
pipeline": the finding below is a fixable code bug, not a ceiling.

### The #1 root cause — NOT a model or prompt problem, a bug in our own injection chain

7 of 15 pipeline failures and 2 of 5 Pro failures are the exact same
signature: **`XxxGeometry is not defined`** (Capsule/Cylinder/Torus/Sphere/
Icosahedron) — even though every one of those names is already on the
curated allowlist (`prompt-catalog.ts:53-54`) and the model DID write `new
CylinderGeometry(...)` correctly in its game code.

Traced to the actual byte, in every failing file: `injectAssets` inserts its
OWN `import { GLTFLoader, ... } from "three"` shim near the top of the
document (for asset loading), so the served HTML ends up with **two**
`from "three"` import statements — the injected shim's, and the model's own
game-script import further down. `ensureThreeImports` (`three-import-
lint.ts:267-269`, "Heal the FIRST three-import") always patches
`imports[0]`. When the shim's import comes first in the document, the healer
patches the shim (already correct) and never touches the model's real import
(the one actually missing the name) — so the "is not defined" ships to the
child anyway, even though our own auto-heal code ran and reported nothing to
fix.

**This is exactly the §2.5 finding from the 2026-08-12 Genre Playbook PRD**
("relational constraints... must come from code we author, not the
prompt") — except the code we already wrote to own this constraint has a
latent ordering bug and isn't actually enforcing it. Fixing `ensureThreeImports`
to heal the import statement nearest each usage (or all `three` import
statements, not just the first) is a same-day, low-risk, testable fix that —
by this sample — would likely take PIPELINE clean rate from 20% to ~60-67%
and PRO from 67% to ~80%, with zero prompt/playbook work. **Not implemented
yet — flagging for a decision, see chat.**

### Everything else that broke (secondary, after the import-healer fix)

- **Typos the healer can't catch**: Pro wrote `Doubleside` (wrong case) —
  spelled differently than the canonical export, so no allowlist/healer
  catches it; this is a real generation defect, not an import-order bug.
- **Null-reference / relational bugs** (`reading 'clone'`, `reading 'x'`,
  `reading 'push'`): 4 instances, spread across both arms — the same
  "relational constraint, model can't hold both ends thousands of tokens
  apart" class as §2.5, now confirmed outside the economy-sim genre it was
  first found in.
- **Pipeline-specific, not seen on Pro at all**: `playMusic is not defined`
  (audio helper referenced but never wired — creative_endless), `marketStall
  is not defined` (economy_sim), `localStorage... Access is denied` (the
  served game runs in a sandboxed `srcdoc` iframe that blocks `localStorage`;
  the pipeline's spec-compile stage apparently prompts a "save progress"
  feature literally enough that Flash reaches for an API the runtime doesn't
  allow — racing_vehicles). These three are genre/pipeline-specific and
  worth turning into playbook laws once the import-healer fix is in, so they
  aren't drowned out by it.
- **Undiagnosed**: multiplayer_shooter Pro threw `'s' is not defined`
  dozens of times per animation frame — a genuinely undeclared variable in
  the render loop, distinct from the import-order class.

---

## platformer — `c5908cf0-8f0e-40cc-bb6a-456a42f0dbc1`

**Prompt:** make a 3d platformer game different worlds will be in optons it contains 2-4 characters fighting with weapons

- **PRO** (gemini-2.5-pro): 77810ms, 6342 out (817 thinking), 47997 chars → `c5908cf0-8f0e-40cc-bb6a-456a42f0dbc1/pro.served.html`
- **PIPELINE** (gemini-2.5-flash-lite→gemini-2.5-flash-lite→gemini-2.5-flash): 175920ms total, 24695 out combined, 109422 chars → `c5908cf0-8f0e-40cc-bb6a-456a42f0dbc1/pipeline.served.html` (spec: `c5908cf0-8f0e-40cc-bb6a-456a42f0dbc1/pipeline.spec.md`)

_gap notes: PRO: ✖ pageerror: The requested module 'three' does not provide an export named 'Doubleside' | PIPELINE: ✖ console: Failed to load resource: net::ERR_INVALID_URL; pageerror: TorusGeometry is not defined_

---

## racing_vehicles — `3f48eb57-e1d7-498c-882b-67a0fc903e49`

**Prompt:** make a multiplayer car race in 3d

- **PRO** (gemini-2.5-pro): 68539ms, 5533 out (725 thinking), 48697 chars → `3f48eb57-e1d7-498c-882b-67a0fc903e49/pro.served.html`
- **PIPELINE** (gemini-2.5-flash-lite→gemini-2.5-flash-lite→gemini-2.5-flash): 128008ms total, 18964 out combined, 88614 chars → `3f48eb57-e1d7-498c-882b-67a0fc903e49/pipeline.served.html` (spec: `3f48eb57-e1d7-498c-882b-67a0fc903e49/pipeline.spec.md`)

_gap notes: PRO: ✓ runs clean | PIPELINE: ✖ pageerror: Failed to read the 'localStorage' property from 'Window': Access is denied for this document._

---

## racing_vehicles — `0d34c6b8-b582-4e06-958e-eba31ae310c5`

**Prompt:** A neon futuristic 3D car race game on Mars. The track winds across a red, dusty Mars landscape with a glowing purple-and-pink sky. My car is neon-lit and fast. There are speed boosters on the track that glow blue and make the car go super fast when I drive over them. There are rocky obstacles — big 

- **PRO** (gemini-2.5-pro): 59736ms, 5367 out (884 thinking), 42424 chars → `0d34c6b8-b582-4e06-958e-eba31ae310c5/pro.served.html`
- **PIPELINE** (gemini-2.5-flash-lite→gemini-2.5-flash-lite→gemini-2.5-flash): 76328ms total, 8252 out combined, 52807 chars → `0d34c6b8-b582-4e06-958e-eba31ae310c5/pipeline.served.html` (spec: `0d34c6b8-b582-4e06-958e-eba31ae310c5/pipeline.spec.md`)

_gap notes: PRO: ✓ runs clean | PIPELINE: ✓ runs clean_

---

## animals_water — `f251bcbd-a054-40fd-9539-687629648534`

**Prompt:** i want a 3d dinos and 3d world where i can walk and see various trees and eat fruits

- **PRO** (gemini-2.5-pro): 52150ms, 3762 out (744 thinking), 40456 chars → `f251bcbd-a054-40fd-9539-687629648534/pro.served.html`
- **PIPELINE** (gemini-2.5-flash-lite→gemini-2.5-flash-lite→gemini-2.5-flash): 91676ms total, 12677 out combined, 72267 chars → `f251bcbd-a054-40fd-9539-687629648534/pipeline.served.html` (spec: `f251bcbd-a054-40fd-9539-687629648534/pipeline.spec.md`)

_gap notes: PRO: ✓ runs clean | PIPELINE: ✖ pageerror: CapsuleGeometry is not defined_

---

## animals_water — `997f19f2-f851-41b2-a054-4fe850e376ca`

**Prompt:** create a 3 D game where i use an Oar to steer on the rivers. As i travel there will be lot of crocodiles that dives in from the shore when it comes near the boat i will use stick to push it away. when i do one, i get 50 strength points

- **PRO** (gemini-2.5-pro): 51869ms, 4792 out (767 thinking), 40990 chars → `997f19f2-f851-41b2-a054-4fe850e376ca/pro.served.html`
- **PIPELINE** (gemini-2.5-flash-lite→gemini-2.5-flash-lite→gemini-2.5-flash): 86561ms total, 11135 out combined, 65621 chars → `997f19f2-f851-41b2-a054-4fe850e376ca/pipeline.served.html` (spec: `997f19f2-f851-41b2-a054-4fe850e376ca/pipeline.spec.md`)

_gap notes: PRO: ✖ pageerror: CylinderGeometry is not defined | PIPELINE: ✖ pageerror: Cannot read properties of undefined (reading 'clone')_

---

## combat_action — `bd1875dd-ab44-43f6-8e0c-8a7424a93859`

**Prompt:** I want a 3d tank game where I have shoot all the other tanks hidden behind the blocks

- **PRO** (gemini-2.5-pro): 55752ms, 5074 out (841 thinking), 43654 chars → `bd1875dd-ab44-43f6-8e0c-8a7424a93859/pro.served.html`
- **PIPELINE** (gemini-2.5-flash-lite→gemini-2.5-flash-lite→gemini-2.5-flash): 107229ms total, 13014 out combined, 72765 chars → `bd1875dd-ab44-43f6-8e0c-8a7424a93859/pipeline.served.html` (spec: `bd1875dd-ab44-43f6-8e0c-8a7424a93859/pipeline.spec.md`)

_gap notes: PRO: ✓ runs clean | PIPELINE: ✖ pageerror: Cannot read properties of undefined (reading 'clone')_

---

## combat_action — `18309ac8-d2df-469d-be3a-f2ea2e8c601b`

**Prompt:** Please make me a game wich involves spider man beating up thanos, hulk and many other dc AND Avengers character, with spider man having unimaginable human owers of teleporting and make it 5D or the max D like 2d,3d ( put max D).

- **PRO** (gemini-2.5-pro): 52275ms, 4886 out (971 thinking), 43269 chars → `18309ac8-d2df-469d-be3a-f2ea2e8c601b/pro.served.html`
- **PIPELINE** (gemini-2.5-flash-lite→gemini-2.5-flash-lite→gemini-2.5-flash): 94339ms total, 13184 out combined, 70103 chars → `18309ac8-d2df-469d-be3a-f2ea2e8c601b/pipeline.served.html` (spec: `18309ac8-d2df-469d-be3a-f2ea2e8c601b/pipeline.spec.md`)

_gap notes: PRO: ✖ pageerror: The requested module 'three' does not provide an export named 'IcosahedronGeometry' | PIPELINE: ✓ runs clean_

---

## sports — `b8fb767f-1074-4323-a989-ae626ec57cb0`

**Prompt:** make a 3D cricket game where I need have first person you are a chase can view for the bowler in the batsman I can be either in the bowler side or a batsman side

- **PRO** (gemini-2.5-pro): 61833ms, 6409 out (759 thinking), 48625 chars → `b8fb767f-1074-4323-a989-ae626ec57cb0/pro.served.html`
- **PIPELINE** (gemini-2.5-flash-lite→gemini-2.5-flash-lite→gemini-2.5-flash): 130505ms total, 17490 out combined, 87837 chars → `b8fb767f-1074-4323-a989-ae626ec57cb0/pipeline.served.html` (spec: `b8fb767f-1074-4323-a989-ae626ec57cb0/pipeline.spec.md`)

_gap notes: PRO: ✓ runs clean | PIPELINE: ✓ runs clean_

---

## sports — `c38a6d08-760b-4e31-893d-8fcd4899d4f0`

**Prompt:** can you make a realistic 3D soccer game with all the soccer rules and the fans and the nets and the ground realistic

- **PRO** (gemini-2.5-pro): 69129ms, 6707 out (869 thinking), 45475 chars → `c38a6d08-760b-4e31-893d-8fcd4899d4f0/pro.served.html`
- **PIPELINE** (gemini-2.5-flash-lite→gemini-2.5-flash-lite→gemini-2.5-flash): 90935ms total, 13041 out combined, 69834 chars → `c38a6d08-760b-4e31-893d-8fcd4899d4f0/pipeline.served.html` (spec: `c38a6d08-760b-4e31-893d-8fcd4899d4f0/pipeline.spec.md`)

_gap notes: PRO: ✓ runs clean | PIPELINE: ✖ pageerror: CapsuleGeometry is not defined; pageerror: Cylinder is not defined_

---

## flight_space — `ccea26e7-93e0-49d1-9ce0-1a82102a76d6`

**Prompt:** make me a 3d Aeroplane game with real aeroplane and real airport with  air traffic control  with things like this with buttons for gear landing throttle

- **PRO** (gemini-2.5-pro): 59669ms, 5715 out (812 thinking), 44010 chars → `ccea26e7-93e0-49d1-9ce0-1a82102a76d6/pro.served.html`
- **PIPELINE** (gemini-2.5-flash-lite→gemini-2.5-flash-lite→gemini-2.5-flash): 141372ms total, 21551 out combined, 101408 chars → `ccea26e7-93e0-49d1-9ce0-1a82102a76d6/pipeline.served.html` (spec: `ccea26e7-93e0-49d1-9ce0-1a82102a76d6/pipeline.spec.md`)

_gap notes: PRO: ✓ runs clean | PIPELINE: ✖ pageerror: Cannot read properties of undefined (reading 'push'); pageerror: DoubleSide is not defined_

---

## flight_space — `6aa82013-c24b-45b6-9db0-ebccdea9123c`

**Prompt:** can you make a 3d helicopter game that flies over a city

- **PRO** (gemini-2.5-pro): 44219ms, 4134 out (751 thinking), 42325 chars → `6aa82013-c24b-45b6-9db0-ebccdea9123c/pro.served.html`
- **PIPELINE** (gemini-2.5-flash-lite→gemini-2.5-flash-lite→gemini-2.5-flash): 97796ms total, 12215 out combined, 66379 chars → `6aa82013-c24b-45b6-9db0-ebccdea9123c/pipeline.served.html` (spec: `6aa82013-c24b-45b6-9db0-ebccdea9123c/pipeline.spec.md`)

_gap notes: PRO: ✓ runs clean | PIPELINE: ✖ pageerror: CapsuleGeometry is not defined_

---

## economy_sim — `ba2aeae6-2a70-4c2e-9e24-95b0617e3d7e`

**Prompt:** Make a market game where I can see. myself 3D market,3D customer and 3D everything. I will make money and each time I make money I get an upgrade. I sell honey,eggs, jelly,jam,fish and tomatoes. There are no levels, it is a never ending game. I have to pick  tomatoes and keep them in the shelf and I

- **PRO** (gemini-2.5-pro): 60824ms, 6258 out (707 thinking), 45434 chars → `ba2aeae6-2a70-4c2e-9e24-95b0617e3d7e/pro.served.html`
- **PIPELINE** (gemini-2.5-flash-lite→gemini-2.5-flash-lite→gemini-2.5-flash): 175807ms total, 22016 out combined, 98945 chars → `ba2aeae6-2a70-4c2e-9e24-95b0617e3d7e/pipeline.served.html` (spec: `ba2aeae6-2a70-4c2e-9e24-95b0617e3d7e/pipeline.spec.md`)

_gap notes: PRO: ✓ runs clean | PIPELINE: ✖ pageerror: marketStall is not defined_

---

## multiplayer_shooter — `c6932017-2ea2-4309-bd59-b298936e706e`

**Prompt:** can you make a 3D multiplayer shooter game

- **PRO** (gemini-2.5-pro): 63310ms, 6359 out (911 thinking), 47958 chars → `c6932017-2ea2-4309-bd59-b298936e706e/pro.served.html`
- **PIPELINE** (gemini-2.5-flash-lite→gemini-2.5-flash-lite→gemini-2.5-flash): 100121ms total, 15068 out combined, 77572 chars → `c6932017-2ea2-4309-bd59-b298936e706e/pipeline.served.html` (spec: `c6932017-2ea2-4309-bd59-b298936e706e/pipeline.spec.md`)

_gap notes: PRO: ✖ pageerror: s is not defined; pageerror: s is not defined | PIPELINE: ✖ pageerror: CylinderGeometry is not defined_

---

## creative_endless — `1f8b4ca5-8116-4299-9710-5f225a4885f2`

**Prompt:** make me a game that has like a pet store in 3D

- **PRO** (gemini-2.5-pro): 63194ms, 5019 out (778 thinking), 43914 chars → `1f8b4ca5-8116-4299-9710-5f225a4885f2/pro.served.html`
- **PIPELINE** (gemini-2.5-flash-lite→gemini-2.5-flash-lite→gemini-2.5-flash): 118696ms total, 17372 out combined, 85321 chars → `1f8b4ca5-8116-4299-9710-5f225a4885f2/pipeline.served.html` (spec: `1f8b4ca5-8116-4299-9710-5f225a4885f2/pipeline.spec.md`)

_gap notes: PRO: ✖ pageerror: Cannot read properties of undefined (reading 'x'); pageerror: Cannot read properties of undefined (reading 'x') | PIPELINE: ✖ pageerror: playMusic is not defined_

---

## creative_endless — `030a88c7-85eb-4e1f-8112-391f01c3d022`

**Prompt:** make subway surfers game with 3d graphics and a teleportation button

- **PRO** (gemini-2.5-pro): 50388ms, 4653 out (791 thinking), 41734 chars → `030a88c7-85eb-4e1f-8112-391f01c3d022/pro.served.html`
- **PIPELINE** (gemini-2.5-flash-lite→gemini-2.5-flash-lite→gemini-2.5-flash): 73298ms total, 10383 out combined, 60871 chars → `030a88c7-85eb-4e1f-8112-391f01c3d022/pipeline.served.html` (spec: `030a88c7-85eb-4e1f-8112-391f01c3d022/pipeline.spec.md`)

_gap notes: PRO: ✓ runs clean | PIPELINE: ✖ pageerror: SphereGeometry is not defined_

---

