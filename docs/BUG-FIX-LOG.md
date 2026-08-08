# Bug-Fix Log

Project-wide record of bugs that reached the codebase, what was actually fixed, the verified
result, and the broader impact. The **single source of truth** for "what went wrong, what we did,
what changed." Governed by the Bug-Fix Protocol in `CLAUDE.md` §9.

- **Open bugs / in-progress** → `docs/KNOWN_BUGS.md`
- **Which tests guard which code** → `docs/REGRESSION-TEST-CATALOG.md`

Entries are **newest first**. Don't rewrite history — fix forward with a new entry.

---

## 2026-08-09 — EVERY stored 3D game broke in production: the import map was correct, and in the wrong place

- **Symptom:** owner UAT on production after deploying the fix below. Five errors, repeated:
  `Failed to resolve module specifier "three"` and `loadModel is not defined`. The whole track
  vanished. Re-prompting could not help — and separately could not run at all (see the Gemini
  credit exhaustion note at the end).
- **Severity:** every 3D game that had ever been stored, all at once. Not a race-track bug.
- **Root cause — POSITION, not presence.** Dumped the owner's actual stored artifact from the box
  (`conversations` row `6a14c96d…`, message 30) and censused its script order:

  | byte | element |
  |---|---|
  | 394 | `<script type="module"> import { GLTFLoader … } from "three"` — the loadModel helper |
  | 5654 | second module script importing `"three"` (batch helper) |
  | **8970** | `<script type="importmap">` |

  A browser IGNORES an import map that appears after module resolution has begun. The map was
  byte-perfect; it was 8.5 KB too late.

  `ensure-runtime.ts` step (1) asked only *"is there exactly one map and is it ours?"*
  (`singleOursAlready`). For this document the answer was yes, so the map was left exactly where
  it sat — deep in the body — while `insertEarly` prepended the freshly re-injected helper to the
  top of `<head>`. Every other check in that function asks "present and correct", never "early
  enough".
- **What activated it:** the `LOAD_MODEL_HELPER_VERSION` 5 → 6 bump in the entry below. A version
  bump makes the helper stale for EVERY stored game simultaneously, so every one of them
  re-injected a module script above its own valid import map on the next render. The flaw was
  latent for as long as maps have been written below the head insertion point.
- **Why the redeploy did not fix it:** the stored artifact was already v6 with an AR_EDGES table,
  so `ensureAssetRuntime` judged it current, produced empty `markup`, and returned the document
  byte-identical — misordering intact. A first fix that only re-emitted the map "when something
  else is being prepended" therefore did nothing here. The correct invariant is unconditional:
  **if the map sits after any module script, move it.**
- **Fix:** `ensure-runtime.ts` now detects `mapAfterModule` (first map index > first module-script
  index) and forces a strip-and-re-emit, and the map is prepended FIRST in `markup` so it precedes
  every helper being spliced in. Guarded on `markup` being non-empty elsewhere, so an already-current
  document is still returned byte-identical and no stored game is rewritten pointlessly.
- **Self-heals:** `ensureAssetRuntime` runs on every preview render, so already-broken stored games
  repair themselves the next time a child opens them. No restamp campaign.
- **Verified on the REAL bytes**, not a fixture — the owner's own artifact, through the new browser
  harness:
  - before: `✖ loadModel:undefined helper:vnull` + `Failed to resolve module specifier "three"` ×2
    + `loadModelBatch is not defined`
  - after: `✓ loadModel:function joins:function helper:v6 assets:6 sizes:6 edges:3 canvas:1`
  - and `ensureAssetRuntime(healed) === healed` (idempotent).

### Why 2,190 green tests did not catch it

Every asset test in this repo asserts on STRINGS in the generated HTML — `expect(html).toContain(
"importmap")`. "The import map is present" and "the import map still resolves `three` at runtime"
are different claims, and only the first was ever tested. Document ORDER was untested, so a
correct map in a fatal position was invisible to all of them.

Two instruments were built in response, and the first found this bug on its first run after four
synthetic fixtures had failed to reproduce it:

- **`scripts/verify-game-html.mjs`** — loads a game in a real browser via iframe `srcdoc` (faithful
  to production; the live report said `about:srcdoc`, and module resolution differs there),
  captures console + page errors from every frame, flags 4xx asset fetches, then probes the LIVE
  window: is `loadModel` a function, is `AR_ASSETS` populated, was a canvas drawn. No model call —
  it runs on any game HTML, including one pulled straight out of the database.
- **`scripts/golden-prompts.mjs`** + `golden/prompts.json` — Layer 2 of the fitness PRD, finally
  built. A small, deliberately DIVERSE set of child-shaped prompts (race track, city roads, dino
  runner, and one plain 2D game so 3D work cannot disturb the 2D floor), run on demand through the
  real generation path and then through the verifier. It never asserts sameness — that would make
  every child's game converge, which is the opposite of the point.

### Also fixed in the same pass (a real defect, but NOT the cause)

The `AR_EDGES` strip regex shipped GREEDY, on the reasoning that its NESTED values needed it. Wrong:
the match is anchored on `</script>`, not on `}`, so a lazy quantifier expands until the TAIL fits
and necessarily stops inside its own block — which is exactly why AR_SIZES and AR_AXES have always
been lazy. Greedy ran to the last `}`+`</script>` in the document, deleting the loadModel helper and
capturing markup that then failed `JSON.parse` silently inside the fail-soft catch. It made
`ensureAssetRuntime` non-idempotent (11612 → 11269 → 11612 across renders; now stable).

This was initially diagnosed as the outage. It was not — `injectAssets` emits byte-identical output
either way, and both builds run clean in the browser. Recorded here because the wrong diagnosis was
briefly acted on, and because a plausible theory that survives a redeploy is worth writing down.

New guard: `src/lib/assets/runtime-tables.invariant.test.ts` tests the property that matters for all
four runtime tables — `strip_X(doc)` must equal `doc` with block X removed **and nothing else**,
byte-exact. Confirmed to fail (4 tests) against the greedy code and pass against the fix. Its
fixture's game script ends with `}` immediately before `</script>`, which is how real generated games
end — three earlier attempts at this test PASSED against broken code because their fixtures did not.

### Unrelated, found while reading the logs (owner action)

`[model-runner]` was returning 429 `RESOURCE_EXHAUSTED` — *"Your prepayment credits are depleted"* —
on chat AND repair, across all three fallback models. No child could generate or fix a game
regardless of any code fix. Owner topped up. Worth a standing alert: this failure is invisible from
the outside except as *"Oops! Something went wrong."*

---

## 2026-08-09 — the race track STILL didn't close: corners had no join data

- **Symptom:** owner UAT, second round. *"The curves did not come properly; the starting and
  ending point also did not come properly."* Screenshots showed curved kerb lines stopping dead
  against the straights, grass showing through a hole in the roadway, and a tall thin white post
  beside the track. Re-prompting could not fix it, again.
- **Reproduction:** the owner supplied the generated game (`racetrack.html`). Run headless, its
  **console was clean** — only WebGL performance warnings. Nothing threw, nothing failed to load,
  so the self-healing repair loop had nothing to catch. Every fault was geometric.
- **Root cause — three faults, all INFORMATION faults, no asset was broken:**
  1. **Corners had nothing to reason from.** `modelAxis()` (the 2026-08-08 fix) answers `'none'`
     for every corner and hub. That is a true answer to "which axis does it run along" and a
     non-answer to the only question that lets a model place a corner. The game guessed rotations
     `0, -pi/2, pi, pi/2`, and the curves met the straights at whatever angle fell out.
  2. **finish_line was scaled independently.** `scale.set(10,10,10)` while the straights got
     `x20`. Its own comment shows the reasoning — it multiplied the piece's LENGTH (2 m) to reach
     the 20 m road and never looked at its width. Result: a 12.6 x **6.68 m tall** x 20 m gantry
     with a 7 m carriageway over a 20 m road. That is the white post in the screenshot.
  3. **It mixed kits.** A "race track" built from the CITY kit, whose `road_curve` is a 2x2
     *sweeping* turn, used as though it were a one-cell corner.
- **Why numbers could not find it, and pixels could:** these tiles are flat, single-material slabs
  with the carriageway painted into the `colormap` texture. The mesh is a rectangle whichever way
  the road runs, and two independent geometric probes (extrusion uniformity, raised-kerb runs)
  both returned "(none)". New instrument: `scripts/render-assets.mjs` renders the PUBLISHED bytes
  top-down through the same loader a kid's game uses and samples the carriageway where it meets
  each edge. It answered every open question in one run.
- **What it measured** (metres, at scale 1). Both kits turn out to be internally consistent, which
  is why nothing needed re-vendoring:

  | kit | carriageway | pieces |
  |---|---|---|
  | city `road_*` | 0.81 m | straight, crossing, intersection, curve, roundabout, bridge |
  | racing `race_track_*`, `finish_line` | 0.70 m | straight, corner, corner_wide, finish_line |

  `race_track_straight`, `race_track_corner` and `finish_line` are all 0.70 m, all centred, all on
  the 1 m module — a complete tiling set the whole time.
- **Two findings the instrument turned up on its first run:**
  - **`road_bridge` runs Z**, alone among the city pieces (every other `road_*` runs X). It had
    been left UNDECLARED since 2026-08-08 because the two geometric probes disagreed (TECH_DEBT
    #93). Until now, any game mixing it with `road_straight` laid the bridge crosswise.
  - **`race_track_curve` is a chicane, proved arithmetically.** It enters the north edge at
    0.498 m and leaves the south edge at **1.002 m** — a cell BOUNDARY on the 1 m grid, not a cell
    centre. Nothing on-grid can follow it, at any scale or rotation. Its `pathAxis` was corrected
    `'none'` -> `'z'`: it is not a corner, it runs along Z and shifts sideways.
- **Fix:** publish what was missing, rather than teach a recipe.
  - `joins` / `joinOffsets` / `lane` / `kit` / `pathRole` on the manifest, MEASURED (a departure
    from `pathAxis`, which is declared) by `scripts/render-assets.mjs` and written by
    `scripts/backfill-tile-edges.mjs --write`.
  - `window.AR_EDGES` + `modelJoins(name)` + `rotateToJoin(name, from, to)` in the runtime
    helper, `LOAD_MODEL_HELPER_VERSION` 5 -> 6.
  - Prompt rule 4: one kit, every piece at the SAME scale factor, and never guess a corner.
- **Migration: none.** The v6 bump IS the migration — `ensureAssetRuntime` re-resolves AR_EDGES on
  every preview render, so the owner's broken track picks the data up the moment it is reopened.
- **Systemic, so it cannot recur:** `src/lib/assets/fitness.ts` (+ the `scripts/lib/fitness.mjs`
  mirror, with a parity test pinning the two together) asks the question no earlier check asked —
  *can this tile tile?* Wired BLOCKING into `vendor-models.mjs` stage 5b for anything being
  published, and as a standing worklist over the whole library via
  `scripts/asset-fitness-sweep.mjs`. Run today: 10 pass, 1 needs-eyes (`road_ramp` — the probe
  cannot separate a ramp's sloped skirts from its tarmac, an admitted gap rather than a guess),
  1 fail (`race_track_curve`, with all three of its defects named).
- **Also fixed while in there:** `vendor-models.mjs` stage 5 replaces a manifest entry wholesale,
  so a re-vendor would have silently dropped the new measurements. It now carries them over, but
  ONLY when the sha256 is unchanged — different bytes mean the measurement is stale, and a stale
  corner definition that looks authoritative is worse than none.
- **Tests:** `fitness.test.ts` (18), `fitness.parity.test.ts` (2). Both suites green: Game 2,187,
  platform 1,160.
- **Cost note:** the prompt token ceiling went 2,450 -> 2,525 — the THIRD fault-driven raise in
  three days, and the first that could not pay for itself by deleting wrong teaching. Recorded in
  `prompt-catalog.test.ts` with the explicit judgement that the next step is the category-map
  hybrid, not more prose.
- **Still open:** `race_track_curve`'s name lies (TECH_DEBT #96) — the asset host is append-only,
  so a rename means a re-upload under a new name, which is an owner decision. In the meantime the
  published `joins` data means a model that consults `modelJoins()` will no longer mistake it for
  a corner.

---

## 2026-08-08 — the same-day parent-PIN fix locked 24 Google families OUT (hotfix)

- **Symptom:** owner report hours after the fix below shipped — "First time here?" in the parent
  area still says no email is on file. Owner: *"it was perfectly working till yesterday."* True.
- **Root cause:** that fix removed this route's `session.email` gate and made the platform the
  sole resolver, via `OwnerProfile.parentEmail`. It assumed profile-email was a superset of
  session-email. Production disagreed: only **18 of 2,447** accounts had an owner profile at all,
  and `players` stores just a one-way `emailHash`. So **32 of 50** registered users could no
  longer set a parent PIN — **24 of them Google accounts that worked the previous day** (Google
  sign-in is what populates `session.email`). It fixed 14 and broke 24. Full analysis, with the
  production numbers, in the platform repo's `docs/BUG_LOG.md` #53.
- **Fix:** ask for the address in place instead of sending the parent to Studio.
  `pin-otp/request` now returns `needsEmail: true` (not a dead end), forwards an optional
  parent-typed address to the bridge, and the parent screen renders an email field with
  purpose-limitation copy right where the address is captured. The platform stores it via a new
  narrow `setContactEmail`, and uses a supplied address **only** when it holds none — so it can
  never redirect an account that already has one (this screen sits behind a child's session).
- **Follow-up same review (2026-08-09), owner challenge — "the email is in the JWT, why was the
  lookup changed?":** correct, and it still is. `session.email` (`ariantra-session.ts:23,51`) was
  never removed; 2026-08-08 simply stopped READING it. Restored as a **fallback**, not as the
  source of truth — being the source of truth was the original bug, since the claim is absent for
  every username/password login. Order is now: address the parent typed → `session.email` → ask.
  A Google family therefore sees no email field at all, exactly as before 2026-08-08, and the
  address gets persisted on first use so it survives a later password login.
- **Tests:** `pin-otp/request/route.test.ts` R.8–R.12 — forwards the typed address, trims it, a
  bodyless request still works (every existing caller sent no body), falls back to the session's
  Google email, and a typed address still WINS over the session claim (a parent correcting the
  address must not be overridden by whichever Google account is signed in on a shared device).
  2161 green.
- **Policy links:** the capture copy links `https://ariantra.com/privacy.html` and
  `/terms.html`. (An earlier draft of this entry claimed no such pages existed — wrong: they live
  in the **Ariantra AI** marketing repo, not in either app repo, which is why a search of these
  two repos found nothing. The `.html` extension is load-bearing; `/privacy` and `/terms` are 404.)
- **Open gap:** `privacy.html` lists the parent email's purpose as *"sending session summaries and
  receipts"* — it does NOT yet mention parent-PIN codes or safety notices, which is what this
  screen captures it for. The policy needs that line before the copy and the policy fully agree.

## 2026-08-08 — 3D tracks came out fragmented, and no amount of re-prompting fixed it

- **Symptom:** owner report — a kid asked for "3D race track, green car, 3 laps". The game
  rendered disconnected road patches scattered over grass. Re-prompting never corrected it,
  which is what makes this different from an ordinary bad generation.
- **Root cause (measured, not inferred):** `road_straight` is a **1.00 × 0.02 × 1.00 m** tile.
  The generated game laid 14 of them at **10-metre intervals** across a 40 × 50 m plane — 14 m²
  of road in 2000 m² of field, i.e. ~99% grass. That is the fragmentation exactly.
  **Why it was unfixable by prompting: no dimension data existed anywhere the model could
  reach it.** `AssetEntry` had no size field; `prompt-catalog.ts` rendered the catalog as bare
  names; `loadModel` exposed no bounding box; and rule 4 of the models section said *"models
  load at their own natural size — set `m.scale` and `m.position` so they fit your scene"* —
  an instruction to **guess**, with nothing to guess from. Every regeneration re-guessed and
  re-guessed wrong. `docs/2026-08-06_PRD_RoadsBridgesJets.md` §Scale ceilings predicted this
  ("if kids' games consistently fail to scale them, revisit"); this is that trigger firing.
- **Second, independent cause found while fixing it:** Kenney's *racing* kit ships **arbitrary
  origins**. `race_track_straight` is a perfect 1 × 1 m tile whose origin sat **1.15 m off in
  Z** (`race_track_curve`, 1.65 m). Its size was never wrong, so no scale normalization would
  have helped — a game stepping the correct 1 m still scattered the geometry. The *city road*
  kit, by contrast, was already correct on both counts: centre-origin and exact whole-metre
  modules (1 m straight/intersection/crossing/ramp/bridge, 2 m curve, 3 m roundabout). The
  original plan to "normalize the road tiles" would have **shrunk the curve's turn radius and
  made things worse**; measurement is what caught that.
- **Fix (four layers, measure → store → ship → teach):**
  1. `AssetEntry.size?: [x, y, z]` — measured metres of the **published** bytes (`manifest.ts`).
  2. `vendor-models.mjs` measures the world-space bbox after every transform and writes it;
     new `normalizeFootprint` (XZ-only, because `normalizeLongest` would scale a tile by its
     kerb height) and `recenterXZ` (+ a post-transform lint that fails the build if a tile is
     still off-centre) options.
  3. `window.AR_SIZES` — a **separate** table from `AR_ASSETS`, with **array** values. Folding
     sizes into `AR_ASSETS` as `{name: {url, size}}` would have re-broken four things: the
     block regexes are non-greedy to the first `}` so a nested object truncates the capture and
     `parseAssetTables` silently returns `[]` (the 2026-08-06 Sky Patrol duplicate-table
     blindness, reintroduced); `loadModel`/`playSound` index the table for a URL string;
     `ensure-runtime`'s idempotence check compares values with `===`; and already-published
     games are immutable and would break permanently.
  4. `window.modelSize(name)` in the loadModel helper (also stamped as `obj.userData.arSize`),
     and prompt rule 4 **rewritten** — the guess instruction is deleted, not merely extended.
- **Existing games:** `LOAD_MODEL_HELPER_VERSION` 3 → 4 plus the new `AR_SIZES` healing branch
  in `ensure-runtime.ts` retrofit both onto every **stored** 3D game on its next preview render
  — no migration. Already-**published** games keep their old immutable URLs and are untouched.
- **Skinned models ship no size, deliberately:** `getBounds()` has no skin handling — it reads
  the bind-space POSITION accessor and multiplies by a node matrix a skinned mesh must ignore
  per spec. 17 models (`dino`, `dragon`, `soldier`, …) are omitted rather than given a
  confident wrong number; `modelSize()` answers `null` and the game eyeballs it exactly as
  before. Every *tile* model is unskinned, so the bug is fully fixed without them.
- **Backfill without a production write:** `scripts/backfill-model-sizes.mjs` measures the
  published artifacts already in `.assets-out/`, touching only entries whose local bytes
  re-hash to the manifest's `sha256`. 245/262 models sized, 17 skinned skipped, 0 unverifiable.
- **Tests:** 464 green in `src/lib/assets/` (full suite 2145). New: `manifest.test.ts` size
  validation + the two headline regressions (every road/track tile ships a size; the city road
  kit stays on a whole-metre module); `runtime-helpers.test.ts` AR_SIZES parse/strip/count +
  an executable `modelSize` check; `inject.models.test.ts` sizes-block emission, fail-soft
  omission and the duplicate-block guard; `ensure-runtime.test.ts` F.16–F.19 (v3→v4 retrofit,
  idempotence, stale-table replacement, 2D untouched); `prompt-catalog.test.ts` pins the new
  teaching and that the old guess sentence never returns.
- **Related:** 2026-08-06 "the sideways black bike" and the rotor no-op — same class, an asset
  property invisible to the LLM.
- **Still owed (needs an owner command — a production write):** `race_track_straight` /
  `race_track_curve` recentring only reaches prod via
  `node --env-file=../Ariantra-Platform/.env scripts/vendor-models.mjs --only=race_track_straight,race_track_curve --upload`.
  Append-only, so published games keep working. Until then those two keep their off-centre
  origins; the seven `road_*` pieces (the modular kit) are correct today. Owner UAT owed:
  regenerate the racer and confirm a continuous track.

## 2026-08-08 — "The race track is poorly formed": the two road kits run along OPPOSITE axes and nothing said so

- **Symptom:** owner UAT, repeated. "The track looks a square and much smaller for car. Also it
  looks road orientation is wrong and the overlapping is there" → Ari rebuilt → "even now the
  roads don't look correct… it orientation looks very wrong." Re-prompting could never fix it.
- **Root cause.** Measured directly against the LIVE glbs: the city kit's `road_straight` runs
  along **X**; the racing kit's `race_track_straight` runs along **Z**. They are perpendicular.
  Nothing exposed that, and `size` structurally cannot — `road_straight` is **1 × 1 m, perfectly
  square**, so its footprint carries zero orientation information. Meanwhile `prompt-catalog.ts`
  rule 4 asserted, as a universal, *"Every model faces +Z at rest"* — true of the racing kit,
  **false** of the city kit. The model believed it, rotated every city tile 90°, and produced
  roads laid ACROSS the direction of travel. Deterministic: same wrong answer every time.
- **What it was NOT.** TECH_DEBT #94 (the un-uploaded race_track origin recentring) looked like
  the culprit and is not: this game builds from `road_*`, whose origins measure exactly (0, 0).
  Running that pending `--upload` would have fixed only the `finish_line` being 1.65 m out of
  place. Worth doing; unrelated to this report. Confirming that before proposing a fix is the
  whole reason the fix is right.
- **Fix — ship the orientation as DATA, and stop the prompt lying.** New optional
  `pathAxis: "x" | "z" | "none"` on manifest model entries, published to games as
  `window.AR_AXES` + `modelAxis(name)` (mirrors the AR_SIZES/modelSize channel exactly: separate
  table, string values, no nested `}` for the block regexes to trip on). Rule 4 now scopes +Z
  facing to vehicles/characters and points tiles at `modelAxis()`. `loadModelHelper` v4 → v5, so
  **already-stored games get `modelAxis` retrofitted on their next preview render** (verified:
  a v4-helper game with no axis table gains `{"road_straight":"x"}` and stays idempotent).
- **DECLARED, not auto-detected — deliberately.** Two independent geometric probes were built
  and both rejected as sources of truth: extrusion-uniformity and raised-kerb/railing runs agree
  on the straights but **disagree on `road_bridge`**, and a deck-edge probe called `road_straight`
  open on all four sides. Shipping a detector's guess would be exactly the confidently-wrong
  value TECH_DEBT #93 exists to refuse, so `road_bridge` is left UNDECLARED and `modelAxis()`
  answers null for it — the game eyeballs it, as it always did. Declarations live beside
  `assertLongAxis`/`recenterXZ` in `vendor-models.mjs`, the same declare-then-lint discipline.
- **Backfill, not re-upload:** `scripts/backfill-path-axis.mjs` writes the declarations into
  `manifest.json` without touching the asset host. Unlike `size` this is not measured from bytes,
  so there is nothing to re-derive — a re-upload of unchanged assets to publish a hand-declared
  string would be an absurd price. Idempotent; doubles as a verification pass.
- **Prompt token ceiling 2400 → 2450 (+39 net).** Not a free raise: rule 4 was compressed to pay
  for most of the new teaching, and the raise is justified in the test comment in the same terms
  as the 2300→2350 rotor and 2350→2400 modelSize raises before it — fault-driven teaching that
  DELETES the wrong teaching it replaces. The baseline was 2398 against a 2400 line, i.e. two
  tokens of headroom, so this could not have been absorbed silently.
- **Tests (+11):** manifest — city=x / racing=z (the disagreement itself), hubs='none',
  `road_bridge` explicitly undeclared, non-path models never carry an axis, and the racing kit
  pinned as OFF the whole-metre module (`race_track_curve` is 1.5 × 2, and the existing module
  test matches only `/^road_/`, so the kit was never checked — now it fails loudly if re-vendored);
  inject — AR_AXES emitted with exactly one table, omitted entirely when undeclared, and
  `modelAxis()` shipped; prompt — the universal "+Z" claim is asserted ABSENT so it cannot return.
- **Still open, unchanged by this:** the layout arithmetic in the generated game had a genuine
  25 m hole (bottom row ends x=275, corner placed at x=325, tiles 25 m wide) — that is the model's
  own maths, not an asset defect, and better axis data should reduce but not guarantee it away.
  TECH_DEBT #94's `--upload` is still owed for the off-centre `race_track_*`/`finish_line` pair.

## 2026-08-08 — Edit turns threw away a working patch and ran a full regeneration (`reconcileBailed=new-asset`, plus a marker-whitespace gap)

- **Symptom:** prod log, four escalations in one window —
  `inSource=false … reconcileBailed=new-asset` ×3 and `reconcileBailed=no-marker` ×1, each
  followed by `patch failed (search_not_found) — falling back to full regeneration`. Nothing
  visibly broke: the kid still got a game. The cost was invisible — a whole extra full-game
  generation per occurrence, and full regeneration is the destructive path that can silently
  regress parts of a working game the child never asked to change (penguin-maze class,
  2026-07-18).
- **Root cause A — the `new-asset` bail was over-conservative against our own injector.**
  `injectAssets` strips `<!--USES_MODELS: …-->` from the delivered game; the model, told to
  always emit markers, re-writes them into its SEARCH block, so SEARCH can't be found in the
  stored source. `reconcileAssetMarkers` exists to rescue exactly that — but it gave up
  whenever a marker named an asset the game didn't already have, reasoning that "a real add
  needs full re-injection." It doesn't: `injectAssets` **already re-injects incrementally**,
  reclaiming the names in the previous `AR_ASSETS` table and unioning them with any markers
  it finds, emitting one merged table (the Sky Patrol bikes fix, 2026-08-06). The add only
  ever needed its marker declarations carried onto the patched HTML.
- **Root cause B — the marker regexes rejected ordinary comment spacing.**
  `MODELS_MARKER_RE`/`AUDIO_MARKER_RE` required `<!--USES_MODELS:` with no space. The model
  sometimes writes `<!-- USES_MODELS: hero, orc -->` like a normal HTML comment; that matched
  nothing. Two consequences, the second worse than the reconcile miss: `hasAssetMarker` said
  "no marker" (the fourth escalation above), **and `injectAssets` injected nothing at all** —
  the game then called `loadModel("hero")` and got `null`, with no error anywhere. A silent
  asset-loss bug, not just a wasted turn.
- **Fix:** `reconcileAssetMarkersWithReason` now returns `{ html, markers }` — the
  marker-stripped reply plus the verbatim marker literals for anything genuinely new (empty
  string when the edit adds nothing, so the common case is byte-identical). `route.ts`
  appends those literals to the PATCHED html before delivery, where `injectAssets` merges
  them with the reclaimed table. `'new-asset'` stays in `ReconcileBailReason` so older log
  lines remain readable, but is never returned. Both marker regexes now tolerate whitespace
  after `<!--`, around the name, and before `-->`.
- **Tests:** `game-edit.reconcile.test.ts` — A.4 and its bail-reason twin rewritten to pin the
  new contract (both explicitly marked SUPERSEDED, with the reasoning, rather than deleted);
  +A.4b (an edit adding nothing returns no markers); **+an end-to-end test against the REAL
  injector** proving old + new land in ONE merged table and exactly one `AR_ASSETS` block
  survives — so if `injectAssets` ever stops reclaiming, this fails loudly instead of shipping
  games whose older models vanished.
- **Note on sequencing:** this fix was deliberately HELD earlier in the day while the
  model-sizing work was mid-flight in `inject.ts`, because its correctness rests entirely on
  that file's merge semantics. Implemented only once that work landed green.

## 2026-08-08 — Keyboard didn't reach the game until the kid clicked the preview

- **Symptom:** owner report — a game loads in the preview, the kid presses the arrow keys or
  WASD, nothing happens. They have to click the preview panel first. Every keyboard game
  therefore started out feeling broken.
- **Root cause:** an iframe receives key events only while it holds focus, and nothing ever
  gave the preview iframe focus. Not a regression — it had simply never been done.
- **Fix:** `ArtifactFrame` focuses the iframe the moment the verify cover lifts (`covered`
  → false) and the Preview tab is showing, re-armed per `docKey` so a rebuild/reload
  re-focuses. Cross-origin-safe: focusing the *element* needs no reach into the
  `sandbox="allow-scripts"` document.
- **The guard that matters more than the fix:** never pull the cursor out of the chat box
  mid-word — that would be a worse bug than the one being fixed. The judgement lives in a
  pure, tested module (`src/lib/preview-focus.ts`, `shouldAutoFocusPreview`) rather than
  inline in the component: focus is taken over BODY/BUTTON/DIV, never over
  INPUT/TEXTAREA/SELECT or a contenteditable. `preventScroll: true` also stops the browser
  scrolling the panel into view under the kid.
- **Tests:** `preview-focus.test.ts` (5, incl. the explicit "never steals from a text field"
  regression and case-insensitive tagName).
- **Not covered:** the effect wiring itself is untested (no component-test harness in this
  repo) — the decision logic is. Owner UAT owed: load a game, press an arrow key without
  clicking first.

## 2026-08-08 — `unknown three imports: loadModel, loadModelBatch` cost a full ~50s corrective LLM retry

- **Symptom:** prod log — `[api/chat] ⛔ unknown three imports: loadModel, loadModelBatch —
  corrective retry @50300ms`. The retry worked, so no kid saw a dead game, but every
  occurrence burned a whole extra model round-trip (~50s and the kid's Sparks).
- **Root cause:** a *category* error, not a missing export. `loadModel`/`loadModelBatch`/
  `modelSize`/`playSound`/`playMusic` are helpers Ari itself injects as `window` globals
  (`inject.ts`'s `loadModelHelper` etc.), and `prompt-catalog.ts` tells the model to call
  them as built-ins — so importing them *from `"three"`* names something the vendored bundle
  will never export. That kills the import line, the whole game script never runs, and the
  existing lint's only cure was a full regeneration.
- **Fix:** `stripRuntimeGlobalImports()` in `three-import-lint.ts` — the third member of that
  file's family (`unknownThreeImports` detects, `ensureThreeImports` adds missing,
  this removes impossible). Drops those names from any `from "three"` list at delivery, and
  drops the whole statement when nothing real is left. Safe by construction: the identifiers
  still resolve at run time from `window`, so the game's own calls are untouched. Wired into
  `toDeliverable`, ahead of `ensureThreeImports`, so it covers every delivery path (fresh
  build, patch, repair fallback) through one choke point.
- **Tests (failing-first, `three-import-lint.test.ts` +8):** strips alongside real three
  names; strips the audio globals; removes the statement when all names were globals;
  handles aliases by ORIGINAL name; leaves a clean import byte-identical; idempotent and
  2D-safe; and — the one that ties it to prod — `unknownThreeImports` goes from
  `["loadModel","loadModelBatch"]` to `[]` after the strip, i.e. the corrective retry can no
  longer fire on this cause.
- **The list must never run ahead of the runtime.** `RUNTIME_GLOBALS` was first drafted by
  grepping `window.X =` across `lib/assets` in a working tree that contained *uncommitted*
  model-sizing work, which picked up `modelSize` — a helper that does not exist on HEAD.
  Stripping a name that isn't really a global trades a loud failure for a quiet one: the dead
  import line (game never runs, verify catches it) becomes a play-time ReferenceError verify
  reports as "clean" — exactly the PointLight class above. `modelSize` was removed and is
  pinned by a test asserting it's left alone; it joins the list when the sizing work ships
  its `window.modelSize` helper.

## 2026-08-08 — Error reports read "undefined (undefined:undefined:undefined)": subresource failures misclassified as script errors

- **Symptom:** owner report — a kid's game ("Super Hero Teleport Battle!") failed its start-up
  check and the copyable error report listed 8 errors, every one of them literally
  `undefined (undefined:undefined:undefined)`. Nothing in the report said what actually failed,
  so neither a grown-up nor the auto-repair loop had anything to act on.
- **Root cause:** `src/lib/game-console.ts` — the injected capture script's capture-phase
  `error` listener decided "is this a failed subresource?" by testing whether
  `e.target.src || e.target.href` was **truthy**. That test misses real subresource failures:
  a media element keeps its URL on `currentSrc` (not `src`), a failed `<source>` child leaves
  nothing on the parent element, and `src=""` is falsy. Those events then fell through to the
  script-error branch — but a subresource failure is a plain `Event`, not an `ErrorEvent`, so
  `e.message` / `e.filename` / `e.lineno` / `e.colno` are all `undefined`. The branch
  string-concatenated them unguarded:
  `fmt(e && e.message) + " (" + (e && e.filename) + ":" + ... + ")"` → the literal text
  `"undefined (undefined:undefined:undefined)"`. Present since the self-healing preview
  landed (`d419e78`, 2026-07-10) — a latent bug that only surfaces on games loading assets
  this way. **Not** related to any deploy: the day's parent-PIN fix never reached production
  (its deploy was declined), and it touches no rendering/SDK/verify code.
- **Second-order damage (the worse half):** `classifyVerify` (`preview-verify.ts:287`) keys
  the specific, repairable `resource_404` verdict off `kind === "resource"`. A misclassified
  event never carries that kind, so verify fell through to `load_error` — and handed the
  auto-repair loop an "error" with no message, no filename and no stack to repair from. A
  clean missing-asset failure was converted into an undiagnosable one.
- **Fix:** classify by the EVENT, not by whether a URL happens to be readable — only a real
  `ErrorEvent` carries a string `message`, so anything else with an element target is a
  resource failure. URL resolution now tries `currentSrc || src || href` and tolerates none
  of them being present (the report names the element instead, e.g.
  `Failed to load <audio> (the element carried no source URL)`). The script branch can no
  longer emit a bare `undefined`: an undescribable error now says so in words.
- **Tests (failing-first, `game-console.test.ts` +3):** V.3b media failure with the URL on
  `currentSrc` is `kind:"resource"`; V.3c a subresource failure with no readable URL is still
  a resource error and names the element; V.3d an error event with no details at all never
  emits `undefined`. V.3d reproduced the reported string byte-for-byte before the fix.
- **Class check:** `lineno`/`colno` handling exists in exactly one place across both repos —
  this file. No platform-side copy to fix.
- **Verify:** full suite green (2105 tests), `tsc --noEmit` clean. What the fix restores is
  the *information*: the 8 failures were real missing resources, and the old report destroyed
  the evidence of which ones. Owner re-test on the affected game owed.

## 2026-08-08 — Parent-PIN OTP (and the screen-time cap alert) falsely reported "no email on file" for username/password logins

- **Symptom:** owner report with a screenshot — `demo` account (username/password login)
  stuck on "Set your family's parent PIN"; requesting the code returned *"Your account has no
  email on file — contact support."* The parent area had been working for this account until
  this point.
- **Full analysis (root cause, scenarios considered, decisions made) in Ariantra-Platform
  `docs/BUG_LOG.md #52`.** Short version: the SSO session's `email` JWT claim is only ever
  populated by Google sign-in or a fresh `register()` — a plain username/password `login()`
  has never included it (the account's email is stored only as a one-way hash, no plaintext to
  embed). That was harmless until 2026-07-27 made the OTP flow (and therefore `session.email`)
  load-bearing for the parent-PIN reset gate. A second, silently-failing instance of the same
  bug existed in the screen-time cap-exceeded parent-alert bridge (fire-and-forget, so no error
  ever surfaced — a username/password family simply never got alerted).
- **Fix (this repo):** `src/lib/parent-pin-otp-bridge.ts` and `src/lib/screen-time-alert-bridge.ts`
  now send `playerId` instead of a plaintext email, and return a structured
  `{ok:true, ...} | {ok:false, error:'no_email'|'send_failed'}` result instead of a bare
  boolean — the platform resolves the real contact email server-side
  (`OwnerProfileService.contactEmail`, the same flow the Sparks low-balance notice already
  uses) and never hands the plaintext back; only a masked address returns for display.
  `src/app/api/parent/pin-otp/request/route.ts` no longer gates on `session.email` — it calls
  the bridge with `session.playerId` and forwards the structured result (a genuine
  no-owner-profile-email account still gets a clear 422, now pointing at Studio account
  settings instead of a dead "contact support"). `src/app/api/screen-time/heartbeat/route.ts`
  now fires the alert bridge unconditionally on a `capExceeded` crossing instead of gating on
  `session.email`.
- **Tests (failing-first):** `parent-pin-otp-bridge.test.ts`, `screen-time-alert-bridge.test.ts`
  (new result-shape contract, playerId not email in the payload), `pin-otp/request/route.test.ts`
  (+2: a session with no `email` claim — exactly a username/password login — still succeeds,
  pinning the actual bug; the genuine-no-email 422 path), `screen-time/heartbeat/route.test.ts`
  (+2: same no-email-claim pin for the alert bridge; a `no_email` bridge result never breaks the
  fail-open 200 contract).
- **Verify:** full suite green (2108 tests), `tsc --noEmit` clean. The `demo` account's live
  data was not queried to confirm — the fix is verified structurally, owner re-test pending.

## 2026-08-07 — "Worked in sandbox, dead published": generated game guessed a no-arg `Ariantra.host()` accessor the preview stub silently swallowed

- **Symptom:** owner report — `cartoon-tank-battle.ariantra.com` broken though the Ari preview
  played fine; separately the error reporter surfaced `ReferenceError: PointLight is not
  defined` from the same game's sandbox.
- **Root cause:** full analysis in Ariantra-Platform `docs/BUG_LOG.md #50`. Ari's generated
  code called `Ariantra.host()` with no arguments from the game loop as a "who is the host?"
  accessor. The preview stub's `host()` no-op masked it; the published SDK treated every call
  as a room-creation attempt (turn-credentials 429 storm, malformed WS `create`). The
  PointLight crash was a missing name in the game's `import { ... } from "three"` list.
- **Fix (this repo):** `multiplayer-prompt.ts` rule 2 now teaches the roster idiom explicitly
  (`players.find((p) => p.isHost)` — "there is no host-getter function to call");
  `preview-sdk-stub.ts` no-arg `host()` now returns the solo host row, matching the hardened
  published SDK's accessor semantics so sandbox and prod behave identically either way.
- **Tests:** `multiplayer-prompt.test.ts` (+1 roster-idiom pin), `preview-sdk-stub.test.ts`
  (+1 accessor parity), both failing-first.
- **Addendum (same day, platform BUG_LOG #51):** the game was STILL dead published — the
  deeper gap was that the preview stub fires `onPlayers` with a solo roster immediately but
  the published SDK fired nothing until the lobby overlay ran, so roster-spawned games showed
  an empty world solo. The platform SDK now implements the same solo-session semantics in
  production; this repo's `multiplayer-prompt.ts` rule 3 updated (myPlayerId is "always a
  real string", roster always contains at least you as host).
- **Addendum 2 (same day, PointLight class killed for future games):** the same game used
  `new PointLight(...)` with PointLight missing from its `import { ... } from "three"` list —
  a play-time ReferenceError the verify pass reports as "clean" (nothing executes the spawn
  path at load). New `ensureThreeImports()` in `three-import-lint.ts` — the MIRROR of the
  existing used-import lint — deterministically appends used-but-unimported CURATED names to
  the game's own import list at delivery (`toDeliverable`), byte-identical otherwise; only
  vendored exports are ever added so the heal can't itself create an import-line crash.
  Tests: `three-import-lint.test.ts` (+10, failing-first). The already-published game was
  healed in S3 directly (platform BUG_LOG #50 rollout notes).

## 2026-08-06 — "The rotor blade is not running": spinning parts looked up by name that no library model has

- **Symptom:** owner UAT (Sky Patrol helicopter, prod) — kid asked repeatedly for the rotor
  blades to spin; Ari answered "all the rotor blades, including the tail propeller, spin super
  fast!" each time, and nothing on screen moved.
- **Root cause:** read from the REAL artifacts, not theorized. The server's 24h `turn_results`
  cache held the actual patched game: it collects spin targets via
  `m.traverse(c => /rotor|blade|prop/i.test(c.name))`. The live helicopter GLB
  (`helicopter.38b1ea.glb`, parsed directly) contains exactly two nodes — `RootNode` and a single
  mesh named `Cube`. No rotor, no bones, no clips. The name match finds nothing, the spin loop
  runs over an empty array, and nothing errors — a **silent no-op**, so every edit "succeeded".
  Catalog rule 7 already said to ADD a primitive rotor on rigid meshes (naming the helicopter!),
  but it also demonstrates name lookups for boned models, and Gemini kept betting on the lookup —
  it cannot see at codegen time that the lookup will match nothing.
- **Fix:** rule 7 (`prompt-catalog.ts`) now states the fact the model kept guessing wrong about:
  rigid models have NO named parts — a name search finds nothing and the spin is a silent no-op;
  the only spinnable parts are ones you add. Pinned by a failing-first test in
  `prompt-catalog.test.ts`. Ceiling raised 2300 → 2350 from the measured value (2334) —
  owner-approved exception to TECH_DEBT #89, recorded there (fault-driven teaching, not an asset
  batch; the category-map hybrid stays the plan for the next batch).
- **Verified:** owner pasted the equivalent instruction ("no parts named rotor — add your own
  crossed thin boxes and spin those") into the live chat BEFORE the prompt change shipped, and the
  rotor spun on the next edit — the wording is live-validated, not hoped.
- **Class note:** same family as the sideways bike (below): when Ari repeatedly "fixes" a visual
  with no effect, suspect an asset property the LLM cannot see (rest orientation, node names,
  rig). The catalog must state what models DON'T have, not just what they have — absence is
  invisible in a prompt that only lists presence.

## 2026-08-06 — The black bike drove sideways no matter what the model "fixed": asset authored 90° off the facing convention

- **Symptom:** owner UAT (Sky Patrol, right after the AR_ASSETS fix made the bikes visible) — one
  black motorcycle always travels sideways; the kid reported it three times and Ari confidently
  "fixed" its steering logic each time with no effect.
- **Root cause:** measured (gltf-transform bounds + real-browser renders, both directions), not
  guessed: `street_motorcycle` was authored nose-at-+X while every other vehicle in the library
  faces +Z. A model's rest orientation is invisible asset metadata — the manifest has no
  orientation field and the catalog taught no convention, so Gemini's one shared `rotation.y`
  rule was right for every bike except this one, and no amount of game-code iteration could ever
  fix it. Full library audit: 77 X-long models, of which 74 are legitimate (T-posing characters,
  guns, fences, bridges span X by design) and 3 are true defects — this bike + both desert/rusty
  tanks (tanks deferred, TECH_DEBT #91: shipped 2026-07-29, existing war-game chats may
  compensate in code; flipping the asset silently would recreate this bug in reverse).
- **Fix (the scalable convention, not a per-game patch):**
  - `scripts/lib/orientation.mjs` — pure facing math (long-horizontal-axis, Y-rotation
    quaternion/translation bake, fix-it lint message), unit-tested from
    `src/lib/assets/orientation-lint.test.ts` (4 tests, failing-first).
  - `vendor-models.mjs` — `rotateYDeg` bakes a facing fix into root nodes (same node-level
    pattern as `normalizeLongest`); `assertLongAxis: 'z'` FAILS curation on any sideways vehicle
    (opt-in per entry — the audit shows a blanket rule false-positives). Flag set on all 13 bike
    entries.
  - `street_motorcycle` re-vendored with `rotateYDeg: -90` → `street_motorcycle.3a0900.glb`,
    uploaded + sha-verified on the asset host; manifest updated (append-only, old URL still live
    for published snapshots). Verified by BEFORE and AFTER renders: nose was at the +X marker,
    now at the +Z marker.
  - `prompt-catalog.ts` rule 4 now teaches the convention globally ("every model faces +Z at
    rest — steer with `rotation.y` alone; +Z is forward") — worded to stay under the 2,300-token
    ceiling (#89 forbids raising it), pinned by test.
- **Existing games:** the same-day AR_ASSETS healing floor re-resolves known model names to the
  CURRENT manifest URL on every preview render, so Sky Patrol picks up the corrected GLB on next
  open after deploy — no chat turn, no migration. No published game references street_motorcycle
  (scanned all 110).
- **Class note:** when a kid reports the same visual bug repeatedly and the LLM keeps
  "fixing" it, suspect an ASSET property the LLM cannot see before suspecting its code. The
  conventions a generator relies on must be enforced where assets enter (curation lint), not
  re-taught per game.

## 2026-08-06 — Models added mid-game never appeared: edit turns left TWO AR_ASSETS tables, the stale one winning

- **Symptom:** owner UAT ("Sky Patrol" helicopter game, prod) — kid asked twice for bikes on the
  roads; Ari replied "I've added cool motorcycles and scooters" both times, yet nothing rendered.
  Gemini's code was CORRECT (real `loadModel("street_motorcycle")` spawn/roam logic, verified in
  the stored artifact). The road stripes it added as a "fix" DID show (plain geometry, no asset
  lookup) — the model was effectively gaslit by our pipeline.
- **Root cause:** edit turns show the model the stored artifact, which we keep POST-injection, so
  its output echoes the previous turn's injected runtime back. `injectAssets` stripped asset
  *markers* but never a previous *injection*, then `insertEarly` PREPENDED the fresh blocks — so
  the echoed stale `window.AR_ASSETS = {…}` executed later in document order and overwrote the
  fresh table. Every model added mid-game resolved to `unknown model` → `loadModel` → `null` →
  silently skipped (fail-soft by design). Harmless while the model set never changed (identical
  map overwrote identical map) — fatal on exactly the first add-a-new-model edit, which is why
  every fresh-game UAT passed. Same mechanism, second symptom: `ensureAssetRuntime`'s probe call
  was guarded by marker PRESENCE, short-circuiting before `injectPerfProbe`'s own version check —
  stranding stored games on perf-probe v2, which predates the idle/`playing` slowdown-banner fix.
- **Fix (two layers):**
  - `inject.ts` — parses echoed tables, reclaims their manifest-known names into the model/audio
    lists (marker names first, so a budget squeeze drops history before this turn's ask), then
    strips all echoed tables/helpers/import-maps before injecting exactly one fresh copy of each.
  - `ensure-runtime.ts` — AR_ASSETS healing is now unconditional for any game calling
    `loadModel`: all tables collapse to ONE union table (newest wins, names re-resolved against
    the current manifest, literal call sites merged in), and the probe guard is gone
    (`injectPerfProbe` is version-aware itself). This floor runs on every preview render, so
    already-broken stored games heal on next open — no new chat turn, no migration.
  - Shared table parse/strip/count helpers live in `runtime-helpers.ts` (one source of truth).
- **Verified:** 8 regression tests written failing-first — inject: edit-turn re-injection yields
  one table containing the new model, one helper, one import map; stale-table names survive a
  forgetful fresh marker; idempotent on own output. ensure-runtime H.1–H.4: duplicate tables
  collapse to the union (the exact Sky Patrol shape — names picked from an array, so no literal
  call sites to recover from); single stale table gains literally-called models; healthy table
  byte-identical; old probe replaced not skipped. Full suite + typecheck green.
- **Class note:** injected-runtime blocks must be REPLACE-on-reinject, never prepend-and-hope or
  skip-if-present — presence is not freshness. Loader helper already did this right
  (version-stamped strip); table + probe-caller now match it. Published games are static S3
  files no floor touches at view time — any published from a broken artifact need a restamp
  (scan + restamp tracked separately).

---

## 2026-08-06 — Share sheet handed out https://localhost:3001/share/chat/… in production

- **Symptom:** owner UAT, minutes after the share feature deployed — the ShareChat sheet showed a
  link with a `localhost:3001` origin on the live site. Forwarding it to anyone off the box would
  have been a dead link.
- **Root cause:** `share/route.ts` built the URL from `req.nextUrl.origin`. Behind the Caddy
  reverse proxy, Next's view of the request origin is the box-INTERNAL one (`localhost:3001`),
  not the public host — same proxy-blindness family as BUG_LOG #44 on the platform side
  (Next's own header stamping vs what the proxy actually sends). Never surfaced in tests because
  the mocked request's `nextUrl.origin` was set to the public host.
- **Fix:** new `publicOrigin()` in the share route — `x-forwarded-host` (then `host`) +
  `x-forwarded-proto` win; a localhost-ish host in production falls back to the hardcoded
  canonical origin (`https://games-lab.ariantra.com`, same value as layout.tsx's `metadataBase`)
  so an internal origin can never leak into a kid-forwarded link; dev keeps `nextUrl.origin`
  (localhost is genuinely correct there).
- **Verified:** regression tests S.7 (forwarded headers win over an internal origin) and S.8
  (production + localhost-only host → canonical, asserts `not.toContain("localhost")`), written
  failing-first; suite + typecheck green.
- **Class note:** any OTHER absolute-self-URL built server-side has the same exposure —
  `metadataBase` is static (fine); nothing else in the repo used `nextUrl.origin` for outbound
  links at the time of this fix (grepped).

---

## 2026-08-06 — Slowdown banner fired on games that weren't being played at all (unstarted preview, idle multiplayer lobby)

- **Symptom:** owner report — "when we don't play a multiplayer game or when we don't start a game
  in the preview pane, we see the game-is-running-slow warning… the design is to slow down during
  non-working and it is picking [that] up." The banner must "fire only when it feels lagging ON the
  game."
- **Root cause:** the same class as the 2026-08-05 hidden-tab entry below, one ring further out.
  That fix taught the probe that a *hidden tab's* zero frames aren't lag — but a fully VISIBLE
  game that simply isn't running yet (start-screen games whose loop begins on tap, a multiplayer
  lobby waiting for a friend) also renders few/zero frames **by design** (no loop; the frame
  governor's deliberate idling). The probe reported those honest near-zero readings as fps, and
  five quiet seconds satisfied `SUSTAINED_LOW_SAMPLES`. Conceptually: low fps means "running slow"
  only while frames are being *attempted and felt* — i.e. during play.
- **Fix (probe v3 + reducer, regression tests in both):** `perf-probe.ts` now tracks the last real
  input inside the iframe (pointerdown/keydown/touchstart, capture phase) and stamps every
  snapshot with `playing` = frames > 0 AND input within `PLAYING_INPUT_WINDOW_MS` (10s).
  `PERF_PROBE_VERSION` bumped to 3 so the version-aware retrofit replaces cached v2 probes on the
  next preview render. `slowdown-nudge.ts`'s reducer drops the low-streak on a `playing: false`
  sample — but deliberately does NOT hide an already-visible banner (the kid stopping to READ the
  banner is itself "not playing"); omitted `playing` (stale probe) keeps pre-v3 behavior.
- **Verified:** vm-sandbox probe tests (never-touched → `playing:false` even with frames; recent
  input + frames → `true`; input but zero frames → `false`) + reducer tests (idle samples never
  accumulate/show, idle mid-streak resets, visible banner survives idle) — full suite green.
- **Owner's second ask in the same report** — "can we know which component is causing this… helpful
  in solving by Ari" — already ships: the "Make it faster" tap sends Ari `buildSlowdownHint()`,
  which names the heaviest model with instance count and animated state (the kid never sees the
  technical text). No change needed there.

---

## 2026-08-05 — Slowdown banner falsely flashed for a couple seconds after leaving Ari and coming back

- **Symptom:** owner report — after switching away from a game preview and returning, the "running
  slow — Make it faster" banner (`slowdown-nudge.ts`) appeared briefly (a couple seconds), then
  disappeared on its own, even though the game was never actually slow.
- **Root cause:** the injected perf probe (`perf-probe.ts`) estimates FPS by counting
  `requestAnimationFrame` ticks over a fixed 1-second `setInterval` window and reporting that count
  directly as `fps`, with no awareness of `document.hidden`. A backgrounded tab genuinely renders
  zero frames — true, but not the same claim as "slow" — yet the probe posted that as a real 0fps
  sample regardless. That alone is enough to satisfy the slowdown banner's 5-consecutive-low-sample
  rule, so returning to a game that had been backgrounded even briefly could already have
  `consecutiveLow` maxed out the moment it became visible again; the banner then cleared within a
  couple seconds once genuine post-resume samples reset the counter. The frame governor
  (`frameGovernor()`) already had `document.hidden` awareness for its own purpose (pausing the
  game loop) — the perf probe's separate frame-counting layer never got the same treatment.
- **Fix:** `snapshot()` now returns immediately without posting (and resets the frame counter)
  whenever `document.hidden` is true, so a background gap is never reported as a real FPS reading
  — the banner's low-sample counter simply never advances during a hidden period, instead of
  advancing on false data and then self-correcting after the fact. Also fixed a retrofit gap
  found while shipping this: `injectPerfProbe()` guarded on marker PRESENCE only (same class of
  bug as `ensure-runtime.ts`'s stale-`loadModel`-helper issue from earlier the same day), which
  would have silently prevented this fix from ever reaching a game already previewed once. Added
  `PERF_PROBE_VERSION` + a version-aware guard that strips and replaces a stale probe, mirroring
  `LOAD_MODEL_HELPER_VERSION`'s pattern.
- **Verified:** `perf-probe.test.ts` — new `node:vm` cases confirm zero samples post while hidden,
  and that frames accumulated before hiding don't leak into the first post-resume reading; new
  retrofit case confirms a stale (unversioned) probe gets replaced, and a current one is left
  byte-identical. Full suite: 188 files / 2010 passed, 1 skipped. `tsc --noEmit` clean.
- **Impact:** reaches every already-previewed 3D game automatically on next preview (the version
  guard is what makes that true — without it, this fix would only have helped brand-new games).
- **Prevention — name the class:** *idle time reported as bad time.* Any measurement that samples
  over a fixed wall-clock window needs to explicitly account for the window not being fully live
  (hidden tab, throttled timer, paused execution) — silence and slowness look identical to a naive
  counter, and only the surrounding context (`document.hidden`) can tell them apart.

---

## 2026-08-05 — Catalog-wide model-rig audit: dog had no run clip, held props floated at the character root, no fallback existed for models missing motion entirely

- **Symptom:** owner reports across several unrelated games — a dog's legs never moved despite
  correct game code, a cricketer couldn't hold a bat convincingly, a helicopter's rotor never spun.
  Initially suspected as more fallout from the same-day `loadModel` cache regression (see the two
  entries below); live investigation showed the runtime was fine — these were real gaps in the
  asset catalog and the prompt teaching around it, not runtime bugs.
- **Root cause, three separate findings from actually downloading and inspecting the real `.glb`
  files (not assumed from symptoms):**
  1. `dog.glb` (sourced from poly.pizza "Pug") only ever shipped `Idle`/`Jump` — no run, walk, or
     gallop clip exists in the asset at all, despite having a complete 12-bone leg rig. Game code
     searching `m.animations.find(a => /run|walk|gallop/i.test(a.name))` was correctly written and
     always came back empty-handed.
  2. `cricketer` (and, by shared rig, every "people"-pack character: `soldier`, `footballer`,
     `explorer`, etc.) has **no hand or wrist bone** — only whole-arm nodes (`arm-left`/`arm-right`
     for the Kenney blocky-character pack, `UpperArm.*`/`LowerArm.*` for the Quaternius
     soldier/hazmat pack). The prompt's existing guidance (`soldier.add(gun)`) parented held props
     to the character ROOT, which doesn't track arm movement at all — a bat/gun looked fixed in
     space while the character's arm visibly swung independently.
  3. `helicopter.glb` is a single static mesh (one node named literally "Cube") with zero
     animation data and zero skeleton — there was never a separate rotor part for any amount of
     code to spin. Same class as several rigid vehicle models.
- **Fix — three parts, all in `Game/src/lib/assets/`:**
  1. **Asset replacement for `dog`** (`scripts/vendor-models.mjs`): swapped the source to a
     different Quaternius "Dog" (poly.pizza/m/2kUk0QqpCg) from the SAME `AnimalArmature`-rigged
     pack already powering the working `cat`/`dino`/`chicken` entries — verified before pinning
     (downloaded raw, confirmed real `Walk`/`Run` clips + full leg rig). Compressed through the
     existing meshopt pipeline to 52.6 KB, essentially unchanged from the old dog's 48.5 KB (well
     under the 150 KB model budget) — the 296 KB raw source size was a red herring, not a real
     cost, since every model goes through the same compression pipeline regardless of source.
     Vendored via `--only=dog --upload` (correct order: build → upload → verify-live → write
     manifest, learned the hard way from the `three.js` bundle incident below).
  2. **Held-prop attachment** (`prompt-catalog.ts`): both the people-pack and soldier-pack clauses
     now teach parenting to the arm bone, not the root — `(m.getObjectByName("arm-right") ||
     m).add(prop)` for the people pack, `(soldier.getObjectByName("LowerArm.R") ||
     soldier).add(gun)` for the soldier pack. Both fall back to the OLD root-parenting behavior if
     the named bone isn't found on a given model (defensive — worst case is unchanged, never a new
     crash), since only ~6 of the ~20 people-pack models were actually checked against their real
     bone names before shipping this.
  3. **General procedural-motion fallback** (`prompt-catalog.ts` item 7, new): teaches Ari to
     handle ANY model that needs to move but lacks the right clip or rig, without ever inventing a
     nonexistent animation name — drive existing bones directly (sine-wave rotation keyed to
     time/speed) if the model has a matching-named rig (`*Leg*`/`*Wing*`), or add its own simple
     primitive part and spin that if the model is a single rigid mesh (names the helicopter
     explicitly as the worked example). This is the system-level answer to "a child can't write a
     technical patch prompt" — it's meant to fire automatically during normal generation, not only
     when explicitly asked.
- **Verified:** the dog asset swap — vendor script dry run confirmed compressed size/animations/
  skin intact before upload; live CDN fetch confirmed post-upload; `manifest.test.ts` contract
  tests green (20 files / 390 tests); full suite 188 files / 2006 tests green; `tsc --noEmit`
  clean. The prompt changes — `prompt-catalog.test.ts`'s existing lockstep/token-ceiling tests
  updated and green (ceiling raised 1900 → 2100 tokens, documented inline, for genuinely new
  correctness content, not creep).
- **NOT verified — flagged explicitly, not assumed:** item 7 (the procedural-motion fallback) has
  not been observed firing on a real generated game yet. Same caution as the `SkeletonUtils`
  lesson below: a reviewed, tested-for-shape prompt instruction is not the same as a proven one.
  The next real game that needs this fallback (a plain, non-technical kid request — "make me a
  helicopter game" — not a technical patch prompt) is the actual test; the generated code should
  be pulled and checked, not just trusted because the game "looks done."
- **Impact:** `dog` now animates correctly in every future/edited game. Held-prop attachment and
  the motion fallback only reach NEW generations and edits — no retrofit path exists for
  already-published games' stored code (same class as TECH_DEBT #87's tier-2 residual).
- **Related:** TECH_DEBT #87 (residual: asset/prompt fixes don't retrofit stored game code).

---

## 2026-08-05 — Error-report fix turns blocked by Gemini SAFETY (HARASSMENT:LOW) — "that one tangled me up" on every paste

- **Symptom (what the user saw):** with the email-PII fix (entry below) deployed, pasting the
  error report reached the model — but every attempt came back with `MODEL_GLITCH_RETRY`
  ("Hmm, that one tangled me up!"): the fix generation itself was blocked, repeatedly.
- **Surface area:** `src/lib/gemini.ts` (`buildContents` safety-context injection); production
  pm2 logs show the block fired many times.
- **Root cause:** Gemini returned `finishReason SAFETY` on the REGENERATED game code with
  attribution `[HARASSMENT:LOW, all else NEGLIGIBLE]` — a false positive (a real block rates
  MEDIUM/HIGH), but the child persona deliberately runs `BLOCK_LOW_AND_ABOVE` for harassment
  (`persona.ts`), so LOW is enough. `CHILD_BUILDER_CONTEXT` WAS already riding on the turn
  (a report contains "game", so `isGameBuildTurn` matched) and did not clear it: its battle/
  rivals framing says nothing about error reports or program code, so the classifier misread
  stack traces + regenerated dog-sled game code.
- **Fix:** error-report turns (message contains `REPORT_HEADER`, now exported from
  `error-report.ts`) get `CHILD_FIX_CONTEXT` — the builder framing PLUS truthful framing of the
  paste as this app's own machine-generated report whose right answer is repaired code
  (`gemini.ts`). Strict superset of the verified builder framing; thresholds untouched — same
  no-posture-change pattern as BUG-FIX-LOG 2026-07-27, per the standing preference for user-turn
  context injection over threshold relaxation. Rejected for now: relaxing child harassment
  LOW→MEDIUM (posture change, owner's call if framing proves insufficient) and an auto-retry on
  all-LOW/NEGLIGIBLE blocks (extra model cost; keep in reserve).
- **Result (verified):** new pinned describe block in `gemini.safety-context.test.ts` (report
  paste → `CHILD_FIX_CONTEXT` leading part; plain build turns keep `CHILD_BUILDER_CONTEXT`;
  adult persona uninjected) — 2 failed before the fix. Full suite 2015 passed, tsc clean.
  **Live UAT pending:** owner re-pastes the Rainbow Dog Sled report after deploy; the 2026-07-22
  and 2026-07-27 precedents both live-verified that user-turn framing clears this class, but
  this specific wording is not yet live-proven. Supporting live evidence (owner, same day,
  pre-deploy): manually typing "I am a game developer" alongside the paste cleared the block
  every time — the injection automates exactly that. If it still blocks, escalate to the
  rejected options above.
- **Impact:** the error-report → fix loop (the whole point of the copyable report) can work for
  kids; no safety-posture change.
- **Prevention — name the class:** *provider-classifier false positive on benign kid content at
  the strictest threshold* — same class as 2026-07-27; the injection now has two pinned variants
  and any new turn TYPE (report paste, future share-paste) should get its own truthful framing
  sentence rather than a threshold change.
- **Related:** entry directly below (same paste, input-rules layer); BUG-FIX-LOG 2026-07-27
  (CHILD_BUILDER_CONTEXT); 2026-07-22 (framing clears provider false positives, verified live).

## 2026-08-05 — The app's own pasted error report got deflected as unsafe kid input ("Let's talk about something else!")

- **Symptom (what the user saw):** owner pasted the copyable game error report (the one
  `error-report.ts` builds precisely FOR pasting into this chat — Rainbow Dog Sled Adventure,
  `verify_failed`, three.js module errors) and Ari answered with the `KIND_REDIRECT` topic-change
  deflection instead of engaging with the broken game. A false "child shared personal info"
  parent alert fired too.
- **Surface area:** `src/lib/safety.rules.ts` (PII email rule); hit via `/api/chat` input
  fast-path (`route.ts` step 1) — any child-mode turn whose text contains a versioned URL.
- **Root cause:** the email regex's domain part accepted any word chars
  (`/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/`), so the npm version specifier inside the report's CDN URL —
  `cdn.jsdelivr.net/npm/three@0.158.0/...` — matched as "email" (`three@0.158.0`), which is a
  `soft_block` → child mode blocks on any non-allow verdict → `KIND_REDIRECT` + parent alert.
  Scunthorpe-class false positive (same family as 2026-07-31), but in the PII layer: the app's
  own artifact tripped the filter meant for kid-typed PII.
- **Fix:** require the domain to end in an alphabetic TLD:
  `/\b[\w.+-]+@[\w-]+(\.[\w-]+)*\.[A-Za-z]{2,}\b/` (`safety.rules.ts:114-118`). Every real email
  ends in a letters-only TLD; a semver specifier never does. Considered and rejected: whitelisting
  the "Ari — game error report" header, because that would be a paste-able PII-scan bypass.
- **Result (verified):** new `safety.rules.test.ts` describe block ("email-PII false positive on
  npm version specifiers") — the full pasted report and a bare `three@0.158.0` now `allow`; both
  failed before the fix. Genuine emails (incl. digit-bearing domains like `mail2.example.org`)
  still `soft_block`. Full suite: 2003 passed; the 2 pre-existing `prompt-catalog.test.ts`
  failures are unrelated (fail identically without this change).
- **Impact:** kids/parents can now paste an error report (or any message with a versioned package
  URL) and get help instead of a deflection; no more false PII parent alerts for it. Safety
  posture: strictly fewer false positives, no weakening — real emails still blocked.
- **Prevention:** regression tests above. **Class: filter false-positive on the product's own
  machine-generated text** — when a feature generates text destined for the chat input
  (error reports, share snippets), run it through `RulesClassifier` in that feature's tests.
- **Related:** 2026-07-31 Scunthorpe entries (same over-blocking class, profanity layer);
  KNOWN_BUGS #7/#12 (input-scan surface); `error-report.ts` (2026-07-20, the report generator).

## 2026-08-05 — Animated 3D models (dog legs, human hands, helicopter rotors) froze at rest pose — regression from the same-day loadModel cache fix, live within hours of deploy

- **Symptom:** owner report, live in production: skinned/rigged models stopped animating —
  legs/arms/rotors sat completely still — across multiple unrelated games (a dog, a human
  character, a helicopter), not one isolated case.
- **Root cause:** the entry directly below this one (same day) added a template cache to
  `window.loadModel()` and, for any model carrying animations, used `SkeletonUtils.clone()`
  (newly vendored) to produce every returned instance — including the FIRST and only instance,
  not just repeats. `SkeletonUtils.clone()`'s bone/skeleton re-targeting was never verified
  against the actual hosted `.glb` rigs before shipping — only reviewed and unit-tested against
  the generated-STRING shape (the established test convention for this file, since real `import
  "three"` can't run in `node:vm`). It silently failed to correctly re-bind at least some of these
  rigs, leaving every clone's skeleton at its bind (rest) pose — `AnimationMixer.update(delta)`
  ran every frame exactly as the game intended, but nothing visibly moved, because the mixer had
  nothing correctly bound to move. Universal, not multi-instance-specific: since the FIRST call for
  any animated name also went through `SkeletonUtils.clone()`, a game with a single dog or a single
  helicopter was equally broken.
- **Fix:** `loadModel()`'s caching is now narrowed to STATIC (non-animated) models ONLY.
  Animated models get ZERO behavior change from any part of this effort: every call does a fresh
  `GLTFLoader.loadAsync()` and returns the pristine parsed scene untouched — byte-for-byte the
  pre-2026-08-05 behavior, the one path known to be correct. The `.glb` bytes are still
  HTTP-cached by the browser after the first load, so a repeat call is a re-parse, not a real
  network round trip — that was always "good enough" for the animated case; the modest extra win
  `SkeletonUtils.clone()` offered (slightly cheaper repeat crowd spawns) was never worth this risk.
  `SkeletonUtils` is no longer imported by the injected helper script at all. `LOAD_MODEL_HELPER_VERSION`
  bumped 2 → 3 so `ensure-runtime.ts`'s retrofit guard replaces the broken v2 helper in every
  already-published game on next preview, same mechanism as the original cache rollout.
- **Verified:** `runtime-helpers.test.ts` rewritten to assert the animated branch never calls
  `.clone()`/`SkeletonUtils` and that a repeat call for an animated name re-enters the fresh-fetch
  path (never short-circuits through the static cache); `ensure-runtime.test.ts` F.13 updated for
  the renamed cache variable. Full suite: 188 files / 2002 passed, 1 skipped. `npx tsc --noEmit`
  clean. Deployed same day.
- **Impact:** animated 3D games broke in production for roughly the window between the v2 deploy
  and this fix — not caught pre-deploy because the risk (SkeletonUtils correctness on real rigs)
  was assessed by review only, never exercised against an actual browser + real hosted model.
- **Prevention — name the class:** *unverified library-behavior assumption shipped straight to
  every user of that code path.* `SkeletonUtils.clone()`'s correctness was treated as a given
  because it's a documented three.js utility, not because it was actually tested against the game's
  own real assets. Any future runtime-helper change touching THREE.js internals (skinning,
  morph targets, custom shaders) needs a real-browser check against the actual manifest models
  before shipping, not just a string-shape unit test — the string-shape convention this file
  already uses is sufficient for verifying WHAT script gets generated, never for verifying that a
  three.js API call inside it behaves correctly at runtime.
- **Related:** the entry directly below (same day) — this is a regression WITHIN that fix, found
  and corrected same-day via live testing, not a separate incident.

---

## 2026-08-05 — 3D games with many repeated props (forests, city blocks, crowds) tripped the "running slow" banner — global fix, not per-game

- **Symptom:** the kid-facing "The game is running slow — Make it faster" banner
  (`src/lib/slowdown-nudge.ts`, driven by the debug Perf tab's red/yellow/green load bucket,
  `src/lib/assets/perf-probe.ts`) was firing across essentially every 3D game placing more than a
  handful of the same prop. Root-caused against a real generated game (`City Helicopter Pilot`,
  ~40 buildings + ~48 trees, each via `loadModel()`).
- **Root cause:** `window.loadModel(name)` — the ONE shared runtime helper injected into every 3D
  game (`src/lib/assets/runtime-helpers.ts`'s `loadModelHelper()`) — did an independent
  `GLTFLoader.loadAsync()` (fresh network fetch, fresh parse, fresh `BufferGeometry`/
  `Material`/`Mesh` graph) on EVERY call, even for a model already loaded seconds earlier. N
  repeated props therefore cost N full draw-call-worthy mesh trees. Not a per-game authoring bug:
  the build prompt (`src/lib/assets/prompt-catalog.ts`'s `modelsPromptSection()`) actively steered
  the model toward "call `loadModel` again per instance... do NOT `.clone()`" — correct given the
  OLD API (plain `.clone()` on a skinned mesh shares one skeleton and breaks independent
  animation), but with no cheaper alternative offered.
- **Fix — two tiers, both in `runtime-helpers.ts`:**
  1. **Template cache.** `loadModel()` now caches the parsed GLTF once per model name; every call
     after the first clones from the cached template instead of re-fetching/re-parsing —
     `SkeletonUtils.clone()` (newly vendored, `scripts/vendor-three.mjs`) for a model with
     animations (correctly re-binds bones/skeleton, unlike plain `.clone()`), plain `.clone()`
     otherwise (cheap — shares geometry/material by reference). This is what finally makes the old
     "do NOT `.clone()` a person" prompt warning obsolete — dropped from `modelsPromptSection()`.
  2. **`loadModelBatch(name, count)`** — a new, explicitly opt-in API (NOT a silent change to
     `loadModel()`'s return shape) that pools many identical STATIC placements into one
     `InstancedMesh` draw call per distinct geometry/material part, returning
     `{ mesh, setInstance(i, transform), boundsAt(i) }`. Kept separate because generated games
     routinely do `new Box3().setFromObject(wrap)` on a loaded model for collision (the exact
     pattern in the game that prompted this fix) — an `InstancedMesh` has no per-instance scene
     subtree for that to walk, so silently swapping `loadModel`'s contract would have broken
     collision in every existing game using that pattern. `boundsAt(i)` is the supported
     replacement, taught alongside the new API in `modelsPromptSection()` item 6.
  3. **Retrofit path.** `ensure-runtime.ts` re-floors the runtime helper into stored game HTML on
     every preview render — the only path that reaches games that already exist — but its old
     guard only checked whether `window.loadModel =` was present at all, not which version. A
     stale helper would have stayed stuck on the old (uncached) behavior forever. Added
     `window.__arLoadModelVersion` and a version-aware guard (`hasCurrentHelper`); a stale helper's
     whole `<script>` block is now stripped (`stripStaleLoadModelHelper`, matched per-script-block
     so it can't accidentally swallow a neighboring importmap/AR_ASSETS tag) before the current one
     is spliced in — leaving both would let the OLD script run last (document order) and silently
     re-clobber `window.loadModel` back to the slow path.
  4. **`perf-probe.ts`** gained `computeBatchedLoad(triangles, drawCalls)` — a batched model's load
     is now `triangles × drawCalls`, not `triangles × instanceCount`; the old formula would have
     kept a 200-instance batched forest red even after its real draw-call cost dropped to ~1.
- **Verified:** new/extended tests in `runtime-helpers.test.ts` (template-cache ordering,
  SkeletonUtils-vs-plain-clone branching, `loadModelBatchHelper` shape), `perf-probe.test.ts`
  (`computeBatchedLoad` unit tests + `node:vm` batched-snapshot scenarios), `ensure-runtime.test.ts`
  (F.13 stale-helper-gets-replaced, F.14/F.15 batch-helper injected only when called), and
  `prompt-catalog.test.ts`'s existing token-ceiling/lockstep-export tests (both re-verified green
  after the prompt wording change). Full suite: 188 files / 2001 passed, 1 skipped.
  `npx tsc --noEmit` clean.
- **Impact:** every already-published 3D game gets the cheaper load path (tier 1) automatically on
  next preview. The draw-call collapse (tier 2) does NOT retrofit into existing stored game code —
  see `docs/TECH_DEBT.md` #87 for that residual scope.
- **Prevention — name the class:** *shared-runtime cost, not per-game authoring* — when many
  generated games show the same symptom, look at what they all share (the injected runtime helper,
  the build prompt) before assuming N separate authoring mistakes. Also: an explicit new API
  (`loadModelBatch`) beats a silent behavior change to an existing one whenever generated code
  already leans on that existing API's return shape in ways not fully enumerable (here:
  `Box3.setFromObject` on a loaded model for collision).
- **⚠ CORRECTION (same day, see the entry directly above):** tier 1 as described below
  originally cached AND `SkeletonUtils.clone()`'d animated models too. That broke skinned-model
  animation in production (legs/arms/rotors frozen) within hours of deploy — animated models were
  narrowed back out of the cache entirely; only static models are cached now. The rest of this
  entry (static-model caching, `loadModelBatch`, the retrofit mechanism) is unaffected and still
  accurate.
- **Related:** TECH_DEBT #87 (this entry's residual — tier 2 needs per-game adoption).

---

## 2026-08-01 — Build-progress narration on EDIT turns always fell back to "the whole ask", never showed per-step lines

- **Symptom:** owner reported that while editing an existing game, the build-progress strip
  (`docs/2026-07-31_PRD_BuildProgressNarration.md`) always showed one static line — their own
  full request text — and never the granular, per-component narration ("adding the jump
  animation", "drawing the background") the feature is meant to show.
- **Root cause:** `kidThoughtLine()` (`src/lib/kid-thought.ts`) rejected the ENTIRE live model
  thought line if `CODE_LIKE` matched anywhere in it. Edit-turn thinking routinely mixes an
  exact code/function reference (a landmark comment, a function name — `GAME_EDIT_PROMPT_SECTION`
  in `src/lib/game-edit.ts` explicitly asks the model to anchor its patch on one) right next to a
  genuinely kid-safe planning sentence, e.g. `"I'll tweak update() for gravity. Time to make it
  feel bouncy!"` — the whole thing was thrown away for the `update()` fragment, even though the
  second sentence was perfectly safe to show. `thinkingLine` stayed `null` on nearly every edit
  turn, so `buildUpdatingLine()`'s already-shipped ask-text fallback (the 2026-07-31 fix) fired
  every single time instead of being the rare fallback it was designed to be. Same-day
  investigation confirmed the SSE plumbing (`gemini.ts` → `model-runner.ts` → `route.ts` →
  `ChatPanel.container.tsx`) is intact and identical for build vs. edit turns — this was purely a
  filter/content mismatch, not a wiring bug.
- **Fix:** `kidThoughtLine()` now splits the thought into sentences and judges each one on its
  own — the first clean, non-code sentence wins, instead of one code-like clause sinking the
  whole line. Only a thought where EVERY sentence is code-like/degenerate still returns `null`
  (fail-closed preserved). No change to the safety bar itself — same `CODE_LIKE`/`MIN_CHARS`
  checks, just applied per-sentence instead of to the whole blob.
- **Verified:** `src/lib/kid-thought.test.ts` — 2 new tests (salvages a clean sentence next to a
  code-like one; still rejects when every sentence is code-like), all 7 tests in the file green,
  plus `src/lib/build-narration.test.ts` (32 tests) unaffected. Full suite green (177 files / 1877
  tests) after the change.
- **Lesson:** a whole-string reject-on-any-bad-token filter degrades badly the moment real model
  output starts mixing safe and unsafe content in the same chunk — the SAME class of bug as the
  2026-07-31 "3D skyscrapers" profanity false-positive (`RulesClassifier` matching a substring
  and rejecting an entire benign word/phrase). Prefer judging the smallest safe unit (a sentence,
  a token) over the whole blob whenever a filter's false-positive cost is "the user gets nothing."

---

## 2026-07-31 — Build progress strip showed nothing derived for small edits

- **Symptom:** owner shipped an edit ("add city buildings and grass on both
  sides of the road") and reported the new emoji-tagged build-progress strip
  (`docs/2026-07-31_PRD_BuildProgressNarration.md`, shipped same day) "was not
  visible" — the preview kept showing a generic caption instead of anything
  reflecting the actual edit.
- **Root cause:** the strip's derived label depended entirely on
  `thinkingLine`, which is only ever set from Gemini's live thought-summary
  text after it passes `kidThoughtLine()`'s safety filter (rejects anything
  under 8 chars or code-like). Small, simple edits routinely produce a thought
  too short or too terse to pass that filter, so `thinkingLine` stayed `null`
  for the whole turn and both surfaces silently fell back to a hardcoded
  generic line with no derived emoji — the feature only ever worked on bigger
  builds that happened to produce enough planning prose.
- **Fix:** `buildUpdatingLine()` (`src/lib/build-narration.ts`) now falls back
  to the kid's OWN request text — already past the input safety gate, so
  nothing can filter it away, and always available — running IT through
  `buildStepLabel()` instead of showing a bare generic caption. A live thought
  line still wins when one exists; only the no-signal case changed.
- **Verified:** `src/lib/build-narration.test.ts` — 6 new `buildUpdatingLine`
  tests (thought-line-present precedence, ask-text fallback emoji-tagged,
  truncation, empty/null handling). Full suite green (176 files / 1868 tests)
  after the change.
- **Lesson:** a narration feature that depends on a safety-filtered model
  signal needs a fallback source that can't be filtered away, or it silently
  degrades to invisible on exactly the small, everyday case a kid is most
  likely to notice.

---

## 2026-07-31 — "3D skyscrapers" got hard-blocked and parent-alerted as profanity

- **Symptom:** a kid asked "can you add 3D skyscrapers and 3D houses and 3D
  flats" — a completely benign build request — and got the generic
  input-block redirect ("Let's talk about something else! How about a fun
  fact, a story, or a game? 🌟") instead of a build.
- **Root cause:** `RulesClassifier` (`src/lib/safety.rules.ts`) matches the
  `PROFANITY` list per token via `word.includes(w)`. The 4-letter entry
  `"rape"` is short enough to occur as a genuine substring of ordinary English
  words — not two words colliding at a boundary (the 2026-07-18 "medic kit"
  bug above), but ONE real word containing it outright: `"skyscrapers"`
  contains `"rape"` at index 5 (`sky` + `s` + `crapers`, i.e. `...s-c-r-a-p-e-r-s`).
  The classic "Scunthorpe problem." Same risk exists for `"grape"`,
  `"grapefruit"`, and `"drape(s)"`.
- **Fix:** added `PROFANITY_SAFE_WORDS`, a small allowlist keyed per profane
  term, checked before blocking: `word.includes(w) &&
  !PROFANITY_SAFE_WORDS[w]?.includes(word)`. Only exempts specific known-safe
  whole words — the bare word `"rape"` and any other word containing it
  (e.g. `"raped"`, `"rapist"`) still hard-blocks exactly as before.
- **Follow-up audit (same day, owner request):** this collision wasn't a
  one-off, so every `PROFANITY` term was scanned against the full macOS
  dictionary (`/usr/share/dict/words`, 236K entries) for every real-word
  collision, then the ones a kid could plausibly type on this product were
  allowlisted: `rape` → also `scrape(r/d/ing)`, `draper`, `drapery`,
  `therapy`/`therapist`/`therapeutic(s)`; `sex` → `sextant(s)`, `sextet(s)`,
  `sexton(s)`, `unisex`, `essex`/`sussex`/`wessex`/`middlesex`; `dick` →
  `dickens` (Charles Dickens), `dickey(s)`; `pussy` → `pussycat(s)`. One is
  product-specific rather than generic vocabulary: `shit` → `shittim`/
  `shittah`, real biblical wood terms (Exodus, the Ark of the Covenant) —
  this app has a Bible-teacher persona (`PRD-BIBLE-TEACHER.md`), so a kid
  asking about shittim wood would otherwise have been hard-blocked and
  parent-alerted. `fuck`/`bitch`/`asshole` had zero dictionary collisions;
  `porn` collisions were all porn-adjacent (no safe words to add);
  `naked`/`bastard`/`nude` collisions were just grammatical derivatives of
  the same word (e.g. `bastardize`), not different-meaning false positives,
  so left as-is.
- **Verified:** `src/lib/safety.rules.test.ts` — all new tests (the original
  skyscrapers case plus the full audit) fail red pre-fix and pass green
  after; confirmed every bare profane word still hard-blocks (no weakening of
  the actual safety floor). Full suite green (176 files / 1874 tests) after
  the fix.
- **Lesson:** short profanity substrings need an explicit safe-word allowlist,
  not just per-token matching — per-token matching only solved the
  cross-token boundary problem (2026-07-18), it doesn't protect against a
  short banned substring occurring naturally inside a longer, unrelated real
  word. Any new short (≤5 char) entry added to `PROFANITY` should be audited
  against a dictionary for this exact failure mode before shipping — a
  systematic scan found real, product-relevant collisions a spot-check of a
  few obvious cases would have missed (`shittim` in particular).
- **Not fixed here, flagged for owner review:** `SELF_HARM` uses the same
  substring style but against the WHOLE message (not per-token), and has its
  own real collisions — `"cut myself a slice of cake"` and `"I want to skill
  myself up in coding"` both currently hard-block (contain `"cutmyself"` /
  `"killmyself"` once spaces are stripped). Left untouched deliberately: a
  false NEGATIVE on self-harm content is far worse than a false positive here,
  and disambiguating "cut myself [an object]" from genuine self-harm phrasing
  needs more than a safe-word list — it needs the text after the match
  inspected, which is a different, higher-stakes kind of change than the
  PROFANITY fix above. Needs an explicit decision before touching it.

---

## 2026-07-31 — The SOS button flashed and vanished: `NEXT_PUBLIC_*` flags never actually reached the browser

- **Symptom:** owner set `NEXT_PUBLIC_ENABLE_HELP_BUTTON=1` and redeployed, but
  the 🆘 button never appeared — except once, briefly: "a robot came in for a
  few milliseconds and gone," seen at the bottom of the preview pane.
- **Root cause:** `helpButtonEnabled()`/`helpNudgeEnabled()` (`lib/help-client.ts`)
  default an `env` parameter to `process.env` and read the specific key off
  it *inside the function body*. Next.js only inlines a `NEXT_PUBLIC_*` value
  into the **client** bundle when the exact expression `process.env.NEXT_PUBLIC_X`
  appears literally in the source text — splitting it across a default
  parameter and a later property lookup never produces that literal pattern,
  so nothing gets inlined. `ChatPanel.container.tsx` called both functions
  with **no argument at all** (`helpButtonEnabled()`), so in the browser the
  default fell through to a generic `process/browser` polyfill package with an
  **empty `.env`** — the flag read as permanently OFF client-side, regardless
  of what was actually configured, for every build since the feature shipped
  (2026-07-28). The **server**, which has a real `process.env`, rendered the
  first HTML correctly — so the button appeared in the initial paint and was
  then removed the instant client-side hydration re-ran the same check against
  the empty polyfill. That mismatch was the "robot" flash.
- **Fix:** both call sites in `ChatPanel.container.tsx` now pass the literal
  expression explicitly — `helpButtonEnabled({ NEXT_PUBLIC_ENABLE_HELP_BUTTON:
  process.env.NEXT_PUBLIC_ENABLE_HELP_BUTTON })` and the nudge equivalent with
  both keys — so Next's build-time substitution has the exact text pattern it
  needs.
- **Verified:** `src/components/help-flags-inlining.test.ts` pins that the
  literal expression appears at both call sites and that neither is ever
  called bare again (fails red against the pre-fix code, green after). Beyond
  the unit test — which can't see this bug on its own, since Node's real
  `process.env` masks it — a real `npm run build` was run with the flags set,
  and the compiled client chunk was inspected directly: the call site now
  reads `ty({NEXT_PUBLIC_ENABLE_HELP_BUTTON:"1"})`, the literal value baked in
  at build time, not a runtime lookup. Full suite 174 files / 1826 green.
- **Lesson:** a `NEXT_PUBLIC_*` env check is only real in the browser if the
  literal `process.env.NEXT_PUBLIC_X` expression appears verbatim at the
  point Next.js's bundler can see it — indirection through a parameter default
  silently defeats it, and a logic-level unit test running in Node cannot
  detect the difference (Node's `process.env` is real either way). Any future
  `NEXT_PUBLIC_*` gate needs either the literal expression at the call site or
  a build-artifact check like the one added here, not just a passing unit test.

---

## 2026-07-29 — The physics playbook pushed games toward `three` exports we never shipped

- **Symptom:** within 20 minutes of the physics deploy, prod logs started
  showing `⛔ patch introduces unknown three imports: Quaternion` — 4 times for
  Quaternion, plus Euler, Matrix4, MathUtils and Raycaster. Each one forced a
  corrective strict-edit retry costing 5–40s of extra generation. The message
  had never appeared in that form before the deploy.
- **Root cause:** the new playbook teaches rotation, aiming and orientation
  maths, and the engine clause literally names `Quaternion` (cannon-es's). The
  model reasonably reached for `THREE.Quaternion` — which the curated engine
  bundle did not export. `three-import-lint.ts` caught it every time (working
  as designed), but catching it costs a retry.
- **Fix:** export the six names the model actually reaches for — `Quaternion`,
  `Euler`, `Matrix4`, `Vector2`, `MathUtils`, `Raycaster`. Measured cost:
  **+1.29 KB** (617.7 → 619.0 KB, budget 650), because five of the six were
  already inside the bundle as internal dependencies; only `Raycaster` adds real
  code. New engine published as `three.b82585.js`; existing games keep their old
  engine forever under the immutability contract.
- **Verified:** bundle builds and uploads clean, `CURATED_IMPORT_NAMES` stays in
  lockstep with `THREE_EXPORTS` (pinned by test), full suite 1760 green.
- **Lesson:** teaching the model a new *technique* implicitly widens the API
  surface it will reach for. The prompt and the vendored bundle are one
  contract — changing either side alone produces retries at best and dead games
  at worst.

---

## 2026-07-29 — A vendor script silently DELETED a model from the manifest (`cannon` name collision)

- **Symptom:** immediately after `scripts/vendor-cannon.mjs --upload` first ran,
  three asset tests went red: *"the manifest carries every military model"*,
  *"all of them sit in the military genre"*, and *"has no entry for a model that
  does not exist"*. The `cannon` MODEL had vanished from `manifest.json`.
- **Root cause:** the new physics-engine script wrote its entry as
  `name: 'cannon'` and upserted with `findIndex(a => a.name === 'cannon')`. The
  military asset batch (same day) ships a model *also* called `cannon` — the
  wheeled artillery piece. The findIndex matched that model row and the engine
  entry **replaced** it. Nothing was wrong with the asset itself: `cannon.51542e.glb`
  was still on the host, correctly hashed and served; only its manifest row was gone.
  Had it shipped, every game referencing `cannon` would have silently lost its model
  (`loadModel` → null → placeholder), with no error anywhere.
- **Fix:** three layers, because the name collision was the trigger but the
  unguarded upsert was the real hazard.
  1. The engine asset is named **`physics`**, not `cannon` — no collision possible.
     Published as `physics.4eb81a.js`; lookups in `inject.ts`, `ensure-runtime.ts`
     and `physics-playbook.ts` updated to match.
  2. The upsert in `vendor-cannon.mjs` is **name+type qualified**.
  3. **Regression test** (`manifest.test.ts`): asset names must be unique ACROSS
     types — the durable guard, since it fails for ANY future `vendor-*.mjs` that
     tries the same thing, not just this one.
  The deleted row was restored by re-running `vendor-models.mjs --only=cannon --upload`
  (deterministic: the object already existed on the append-only host, so it was
  re-verified rather than re-uploaded).
- **Verified:** manifest back to 201 models with `cannon` present as a `model`;
  two engine rows (`three` 618 KB, `physics` 82 KB); full suite green.
- **Impact / lesson:** the vendor scripts' stage-4 "run the contract tests" gate is
  what caught this within seconds of the upload — it is not ceremony. Also note the
  blast radius was bounded by the append-only host: the bad manifest never reached
  a deploy, and no published game could have been corrupted, only future ones.
  The orphaned `cannon.4eb81a.js` object stays on the host forever, unreferenced
  and harmless — the documented cost of an append-only design.

---

### 2026-07-29 — The chat page's hover-to-reveal nav is gone: it cost a mouse trip and reclaimed no space at all

- **Symptom (owner report):** "in ari chat the nav menu hides and when i go it reappears on
  hovering, it is an useless thing let the nav menu be fixed."
- **Surface area:** `src/components/ArNav.tsx`, and the rules' source of truth
  `Ariantra-Platform/scripts/build-brand-css.mjs` (→ regenerated
  `public/brand/ariantra-brand.v1.css`, synced into this repo).
- **What it was:** shipped one day earlier (2026-07-28) to buy vertical space while chatting — on
  `/` only, the nav slid off the top after 1.2s and came back on hovering a 16px invisible strip.
- **Why it was wrong, beyond taste:** the hide was `transform: translateY(-100%)`, and a transform
  **does not affect layout**. `<ArNav/>` is a direct flex child of `body`
  (`display:flex; flex-direction:column`, `globals.css`), so its ~56px row stayed reserved whether
  the bar was painted there or not. The chat area never grew by a single pixel — the feature moved
  the bar out of sight, left its empty white strip behind, and charged a deliberate trip to the top
  of the screen for every use. It also had no touch equivalent (the rules were gated
  `@media (min-width: 861px)`), so desktop and mobile navigation diverged for no reason.
- **Fix:** the nav renders a plain `.ar-nav` on every route again — the reveal state, timers,
  pointer/focus handlers and hover strip are deleted from `ArNav.tsx`, and the modifier +
  hover-strip rules are deleted from the brand-kit **generator** rather than left as dead CSS, so a
  stray class name in any consuming app can't resurrect the behaviour. Regenerated with
  `npm run build:brand` and synced with `scripts/sync-brand.sh` (never hand-edit `public/brand/`).
- **Verified:** `ar-nav-fixed.test.ts` (6) pins both halves — no modifier/hover-strip class and no
  reveal timers or pointer handlers in the component, and no such **rules** in the generated CSS
  (prose in the header comment is allowed, a rule is not) — plus the nav itself is still styled, so
  this removed a behaviour and not the bar. Typecheck + full suite + build clean.
- **Lesson:** an auto-hide that uses `transform` on an in-flow element hides the pixels but keeps
  the space. If a future change really needs the vertical room, it has to take the element **out of
  flow** (`position: fixed` + compensating padding) and answer the touch story first.

### 2026-07-28 — "Ask, switch tab/chat, come back" lost the answer: tab-close recovery gave the server 6 seconds and deleted its own bookmark

- **Symptom (owner report):** "if we ask something on a chat and leave when it is working to some
  chat or other tab and come back, expectation is that it should get completed — but most of the
  time it fails or stops midway." The waiting bubble stayed frozen on partial code or
  "📶 Reconnecting… hang tight!" forever, even though the server had finished (or was still
  finishing) the reply.
- **Surface area:** `src/components/ChatPanel.container.tsx` (mount bootstrap, `runStream`,
  write-through effect), `src/lib/turn-resume.ts`, new `src/lib/turn-recovery.ts`.
- **Root cause:** three compounding client-side mistakes in the tab-close recovery path — the
  server half was never at fault (`/api/chat`'s ndjson producer no-ops its writes after a
  disconnect and still records `turnResults.complete`, so the generation *does* finish with nobody
  listening):
  1. **The bookmark was deleted before the reply was collected.** `clearPendingTurn` ran *first*,
     then a single poll. Miss it once and the finished reply was unreachable forever.
  2. **6 seconds of patience, and `running` treated as final** (`maxMs: 6_000`, with the comment
     "`running` turns are stale by now"). That assumption is simply false: a build takes 30–180s,
     so a kid returning promptly almost always hit `running` — i.e. the common case was coded as
     the dead case. The LIVE retry path in the same file waits 240s for exactly this reason.
  3. **Recovery ran BEFORE the chat bootstrap**, so the cross-browser auto-restore
     (`setConvos([convo])`) could replace the list and wipe a just-recovered reply; and it blocked
     the Recents index behind its poll.
  Two adjacent leaks made "leave to some chat" worse: the finished-turn write-through persisted
  `activeId`'s chat instead of the chat the turn belonged to (switch chats mid-build ⇒ the reply
  never reached the server, so it vanished on the next device/cache clear), and `setArtifact` /
  `setThinkingLine` were unguarded, so a background chat's game popped into the chat on screen.
- **Fix:** recovery now behaves like the live path. `pollTurnOutcome` (new, in `turn-resume.ts`)
  reports *which* ending it reached — `done` / `running` / `error` / `unknown` — instead of
  reply-or-null, and `pollTurnResult` is a thin wrapper over it (all existing callers/tests
  unchanged). New pure module `turn-recovery.ts` holds the decisions: `keepBookmark` (only a
  `running` turn younger than `RECOVERY_MAX_AGE_MS` = 15 min keeps the bookmark — a deploy/crash
  leaves a `running` row nobody is generating, which must not produce a permanent "still
  finishing" note), `applyRecoveredReply` (patches the turn's OWN chat by `replyId`, reporting
  `patched: false` when the bubble isn't on this device), and `noteStillWorking` (an idempotent,
  swappable in-bubble note — no stacking across a minutes-long poll). The container's
  `recoverPendingTurn` runs in `bootstrap().finally()` (after the auto-restore, never blocking the
  index), pulls the chat from `/api/chats/:id` if this device never cached it, tells the kid
  "Ari is still finishing this one — it'll pop in here", polls with the full `RESUME_MAX_MS`
  budget, keeps the bookmark on `running` for the next load, and PUTs the recovered convo so other
  devices see it. Write-through is now keyed to `turnConvoIdRef` (the turn's chat), and the preview
  / thinking line only move when the turn's chat is the one on screen.
- **Verified:** `src/lib/turn-recovery.test.ts` (13) + `src/lib/turn-resume.test.ts` (11,
  incl. the outcome matrix and a guard that the default budget stays in minutes) — full suite
  155 files / 1554 tests green, `npm run typecheck` clean. The pure helpers are the regression
  guard; this repo's Vitest runs in the `node` environment, so there is no DOM render test for the
  container wiring itself.
- **Impact:** the leave-and-come-back promise now actually holds — a reply finished while the kid
  was away lands in its chat on the next visit (or the visit after that, while the server is still
  working), and a reply built while they read another chat is persisted under the right chat
  instead of only locally. Known remaining limitation (`docs/KNOWN_BUGS.md`): `busy` is still a
  single global, so a build in chat A also shows chat B as busy — ideas typed there queue on B's
  own line and drain after, so nothing is lost, but the composer state is shared.

---

### 2026-07-28 — Parents never got an email when a child exceeded their daily screen-time cap (PRD v1 recommendation shipped only half)

- **Symptom:** `../Ariantra-Platform/docs/PRD-SCREEN-TIME.md` §9 Decision 6 recommended BOTH an
  email alert (D1) and an in-app Parent-tab log (D3) for v1 — only D3 (`SqliteAlertStore`, this
  repo) ever shipped. A parent whose child hit the daily cap had no signal unless they happened to
  open the Parent tab themselves.
- **Surface area:** `src/lib/screen-time.ts`, `src/lib/db.ts` (`SqliteScreenTimeStore`), new
  `src/lib/screen-time-alert-bridge.ts`, `src/app/api/screen-time/heartbeat/route.ts`, new
  `src/lib/screen-time-events.ts`, `src/components/ScreenTimeHeartbeat.tsx`, new
  `src/lib/screen-time-nudge.ts` + `src/components/ScreenTimeNudgeBanner.tsx`,
  `src/components/ChatPanel.container.tsx`; Platform repo: `src/lib/auth/email.ts`,
  `src/lib/email/recording-email-sender.ts`, new
  `src/app/api/studio/partner/screen-time-alert/route.ts`.
- **Root cause:** scope cut during the original PRD-SCREEN-TIME-CAP-MVP push — D1 was never
  re-decided, just quietly dropped, and nothing flagged the gap against the PRD's own
  recommendation.
- **Fix:** `SqliteScreenTimeStore.recomputeAndMaybeAlert` now returns edge-triggered
  `{ activeMinutes, capMinutes, nearingCap, capExceeded }` — a new `nudgedAt` guard column
  alongside the existing `alertedAt` (same ALTER-on-missing-column migration idiom as
  `billedPromptTokens`), computed in the SAME query pass, no extra DB round-trip. On a fresh
  `capExceeded` crossing with a resolvable `session.email`, `/api/screen-time/heartbeat` fires a
  fire-and-forget (`void ...catch()`, never awaited) call to the platform's new
  `/api/studio/partner/screen-time-alert` bridge (`AUTH_JWT_SECRET` as the shared `x-admin-secret`
  header value, same convention as `parent-pin-otp`) — the heartbeat's fail-open `{ok:true}` 200
  contract is untouched even if the platform is down. `db.ts` stays DB-only: the bridge call lives
  in the route, not the store. The existing in-app alert (`SqliteAlertStore`) is unchanged. A new
  child-facing element (not in the original D1/D3 scope): a warm, non-alarming in-chat nudge
  banner ("You've been chatting for a while today — almost time to wrap up soon! 🌙") fires
  `NUDGE_BEFORE_CAP_MINUTES` (5) before the cap, via its own edge-triggered `nearingCap` flag and a
  tiny pub/sub module (`screen-time-events.ts`) — needed because the always-mounted
  `ScreenTimeHeartbeat` and the chat-page-scoped banner aren't in a parent/child relationship.
  Shown-tracking mirrors `rename-notice.ts`'s localStorage pattern but resets once per UTC day
  (a new cap window each day should re-show, unlike the rename notice's forever-once).
- **Result (verified):** new regression tests — `db.screen-time.test.ts` (capExceeded and
  nearingCap each true on exactly the first crossing call, false on repeats, same day);
  `heartbeat/route.test.ts` H.5-H.8 (response echoes the flags; bridge fires only on capExceeded +
  email; a rejected/failed bridge call never changes the 200 response); new
  `screen-time-alert-bridge.test.ts`, `screen-time-events.test.ts`, `screen-time-nudge.test.ts`.
  Full suite (153 files / 1513 tests) + `tsc --noEmit` clean in this repo; Platform repo's full
  suite (117 files / 1040 tests) + `tsc --noEmit` clean too, including new
  `screen-time-alert.integration.test.ts` (403 without/with-wrong secret, 400 on each invalid
  field, successful send recorded on the fake `EmailSender`) and a `recording-email-sender.test.ts`
  case confirming the new `screen_time_alert` `EmailKind` records metadata only, no usage detail
  in the log body.
- **Prevention:** Class — **a PRD recommendation with two co-equal parts (D1 + D3) shipping only
  one part is a silent scope cut, not a completed decision**, and nothing in the original rollout
  flagged the other half as still owed. `docs/PRD-SCREEN-TIME.md` §9 now carries a dated note
  closing the gap explicitly, so future readers see it as resolved, not as still-recommended.
- **Related:** `../Ariantra-Platform/docs/BUG_LOG.md` #46 (same date, cross-repo entry for this
  same gap); `../Ariantra-Platform/docs/PRD-SCREEN-TIME.md` §9 Decision 6 (dated note added same
  day); 2026-07-27 "parent who forgot their PIN" entries below (same `x-admin-secret` bridge
  convention this reuses, unchanged).

---

### 2026-07-28 — Internal asset markers could render as raw text in the child's chat bubble

- **Symptom:** on an edit that adds sound, the chat bubble showed the friendly sentence followed
  by literal `<!--USES_AUDIO: pop, chime-->`. Cosmetic only — the game and its sounds work — but
  to a 7-year-old an unexplained code fragment reads as "I broke it".
- **How it was found:** not reported by a user. Spotted in the output of the edit-turn A/B run
  for the next-ask feature, and deliberately chased rather than assumed unrelated (a
  misdiagnosis earlier the same day came from reading past exactly this kind of detail).
- **Surface area:** `src/lib/assets/markers.ts`, `src/lib/game-edit.ts`.
- **Root cause (pre-existing, unrelated to next-ask chips):** asset markers are instructions to
  our own injector, invisible while inside game CODE (they are HTML comments). The model
  sometimes writes one ABOVE its patch instead of inside the document. `editReplyProse` builds
  the kid-facing line as `reply.split(/<{7} SEARCH/)[0]` — everything before the first patch
  block, verbatim — and `stripAssetMarkers` was applied to source manipulation and HTML but
  NEVER to displayed prose (confirmed by grepping every call site). So a marker in that region
  went straight to the bubble. `streamingDisplayText` had the same gap, and worse: it only cuts
  at `<{4}`, and a marker is a single `<`, so it also flashed live while streaming.
- **Fix:** new `stripAssetMarkersForDisplay` (markers.ts) — `stripAssetMarkers` plus removal of
  an unterminated `<!--…` tail, which complete-marker regexes cannot match and which is the
  common state token-by-token mid-stream. Applied to the three kid-facing prose paths:
  `editReplyProse`, `regenReplyProse`, `streamingDisplayText`. Deliberately NOT applied to
  fenced code blocks — markers there are part of the code the child chose to look at, and
  stripping them is a separate design question.
- **Result (verified):** unit tests cover the exact observed wording plus all three marker types,
  the marker-only-prose edge case (must still fall back to a friendly line, never blank), and
  four partial-marker streaming states. Live: the leak-producing audio edit re-run 3× — marker
  present in the raw model stream all 3 times, absent from displayed text all 3 times. Then a
  throwaway harness replayed a REAL captured stream through `streamingDisplayText` at all 2,142
  character prefixes — zero leaks at any point. `tsc --noEmit` clean; 154 files / 1538 tests pass.

---

### 2026-07-28 — Next-ask chips suggested starting a BRAND-NEW game instead of continuing this one

- **Symptom:** Kid report — "in the memory game with turtle, after an edit very unrelated
  suggestions are there." The chips under a turtle memory game read e.g. `Make me a maze game
  with trains 🚂` · `Make me a flying game with monkeys 🐵`.
- **Surface area:** `src/lib/next-ask-hints.ts` (`buildFallbackNextAskHints`), new
  `src/lib/tweak-suggestions.ts`.
- **Root cause (confirmed, not inferred):** on an edit turn the model is never asked for
  suggestions (`nextAsk=false` — by design, the SEARCH/REPLACE contract), so route.ts falls back
  to `buildFallbackNextAskHints`. That function called `suggestionsFor()` — the **starter pool**
  from `game-suggestions.ts`, whose 500 entries are ALL `Make me a {mechanic} game {theme}`.
  Those exist for the BLANK first-message screen; their entire purpose is to start a brand-new
  game. Served as "what to try next" on a game already in progress they are both nonsensical
  and destructive: tapping one abandons the kid's game to build a different one. The model was
  never involved — these strings were generated locally by our own fallback.
- **How it was found:** the reporter pushed back on an earlier misdiagnosis and asked what the
  edit turn actually sends and receives. Tracing it showed the edit reply contained ONLY the
  prose line + patch hunks — no suggestions at all — which pinned the chips to our own fallback
  code rather than anything the model returned. The exact failing strings had already appeared
  in an earlier live-test transcript and been read past.
- **Fix:** new `src/lib/tweak-suggestions.ts` — a "change THIS game" pool
  (`Add a power-up I can collect ⭐`, `Make it a little faster`, `Add a second level`, …) plus a
  bible-teacher variant, replacing the starter pool in `buildFallbackNextAskHints`. The
  imagination-spark third chip is unchanged (it was already appropriate). The fallback only ever
  fires when a game exists (route.ts gates on `deliverableHtml`), so "change this game" phrasing
  is always the right register.
- **Result (verified):** regression tests assert no fallback hint may ever match `^Make me a `
  (in both `tweak-suggestions.test.ts` and `next-ask-hints.test.ts`, the latter probing five
  different `rand` values across both personas). `tsc --noEmit` clean; full suite passes.
- **Follow-up, same day (owner-approved, now shipped):** the generic pool was the *safe* fix but
  still not game-aware, so edit turns now ALSO get real contextual suggestions from the model,
  via `NEXT_ASK_EDIT_PROMPT_SECTION` — one trailing line after the last `>>>>>>> REPLACE`.
  The concern that blocked this originally ("no prose after the patch blocks" is a hardened
  rule) was investigated rather than assumed: `applyPatch` anchors on the SEARCH/REPLACE sigils
  and ignores all other text, `editReplyProse` displays only what precedes the first block, and
  `streamingDisplayText` cuts at the first `<<<<` — so the line is mechanically inert on every
  path. Asserted in `next-ask-sentinel.test.ts` (including an `applyPatch`-produces-identical-
  output test), and measured live: same base game + same 5 edit prompts, flag on vs off →
  **5/5 clean `✓ edit patch` in both arms**, no leaked sentinel, and suggestions became
  turtle-specific ("Make the turtles make a bubble sound when they match!"). The static pool
  remains the fallback for a missing/malformed line. Caveat: n=5 per arm — small. If edit-patch
  failures rise in prod, this prompt section is the first thing to revert (it's one `isEdit`
  branch in `buildTurnSystemInstruction`).

---

### 2026-07-28 — Next-ask chips could show suggestions for a different game than what's on screen

- **Symptom:** Kid report — on a turtle memory-matching game, after an edit, the "what to try
  next" suggestion chips were unrelated to the game.
- **Surface area:** `src/lib/gemini.ts` (`configFor`), `src/app/api/chat/route.ts`.
- **Root cause:** the next-ask feature flag gated a PROMPT SECTION, but `configFor`'s `nextAsk`
  was computed from the flag alone (`kidHintsEnabled() && !isEdit`) — and `configFor` is the
  SAME choke point every retry/regeneration one-shot in route.ts goes through
  (`completeTruncatedBuild`'s corrective retry, the import-lint corrective retry,
  `strictEditRetry`, and — the likely actual culprit here — the edit branch's OWN
  `forceFullRegen` fallback, which fires whenever a patch attempt fails to apply cleanly).
  Because `forceFullRegen` bypasses `isEdit` in that same function, every one of those internal
  calls silently ALSO got asked to invent 3 NEXT_ASKS suggestions whenever the flag was on — not
  just the one primary stream the kid actually watches. On an edit that fell back to a full
  rebuild, that meant the suggestions could reflect whatever the REBUILD turned out to be, not
  necessarily the game ultimately shown.
- **Fix:** `nextAsk` is now an EXPLICIT per-call opt-in (`resolveNextAsk`,
  `src/lib/next-ask-sentinel.ts`), never re-derived from the flag inside `configFor`. Only
  route.ts's one true primary `chatModel.replyStream()` call passes `nextAsk: kidHintsEnabled()`;
  every retry/regeneration call omits it, so it's `false` there regardless of
  `forceFullRegen`/`isEdit`.
- **⚠ CORRECTION (same day):** this entry originally dismissed the fallback-pool behavior below
  as "by-design, not a bug". That was WRONG — it was the actual reported bug. See the next
  entry ("Next-ask chips suggested starting a brand-new game…"), which is the real root cause
  and fix. The `resolveNextAsk` change described above is still correct and worth keeping, but
  it hardened a *latent* issue and did NOT fix what the kid reported. Recorded rather than
  rewritten, per this log's fix-forward rule — the misdiagnosis is itself the lesson: the
  reproduction was sitting in my own live-test output (`Make me a maze game with trains 🚂`
  returned after an edit) and I read past it.
- **Result (verified):** new `resolveNextAsk` unit tests (`next-ask-sentinel.test.ts`) pin the
  exact regression (an omitted opt-in must default to false, not inherit the flag). `tsc --noEmit`
  and full suite (153 files / 1517 tests) pass. Live end-to-end re-run against the real Gemini
  API: built a turtle memory game (contextual suggestions confirmed), then sent a follow-up edit
  that patched cleanly — server log confirms `edit=true nextAsk=false` on that turn, and the
  `done` event carries a clean fallback-pool suggestion set with no leaked `NEXT_ASKS` text.
- **Open question for the reporter:** was the GAME PREVIEW itself also replaced by something
  unrelated (not just the suggestion chip text)? If so, that's a separate, likely pre-existing
  full-regeneration fidelity issue (this codebase has several prior BUG-FIX-LOG entries about
  edit regeneration going off-track) — worth a fresh report with the exact prompt used, since
  this fix only addresses the suggestion-chip mismatch, not what the rebuilt game contains.

---

### 2026-07-28 — Resize-handle drag could get stuck, blocking every click until a refresh

- **Symptom:** Kid/owner report — pulling the middle divider to resize the preview pane, then
  clicking into the game area or the chat, sometimes did nothing at all. Recovering required
  refreshing the page. Happened multiple times.
- **Surface area:** `src/components/PanelResizeHandle.tsx` (pull-to-resize handle, added in
  `32e1642`), `src/lib/preview-pane.ts`.
- **Root cause:** while dragging, a full-viewport transparent shield
  (`fixed inset-0 z-[120]`) is mounted so pointer events keep tracking smoothly even when the
  cursor crosses the game's iframe (which would otherwise swallow them). The shield was torn
  down ONLY inside the `onPointerUp` handler. If the browser fired `pointercancel` instead —
  which happens whenever pointer capture is lost mid-drag without a clean release (tab/window
  blur, a right-click during the drag, an interrupted touch gesture) — `dragging` never went
  back to `false`, so the shield stayed mounted forever, silently intercepting every subsequent
  click across the whole page.
- **Fix:** extracted the drag start/end decision into a pure, testable function
  (`nextDragState`, `src/lib/preview-pane.ts` — this repo's established pattern: policy logic in
  `lib/`, the component stays presentational) that treats `"cancel"` exactly like `"up"` — both
  end the drag. Wired `onPointerCancel` AND `onLostPointerCapture` (belt-and-braces — different
  browsers can fire either) to the same end-of-drag path `onPointerUp` already used, so the
  shield unmounts and the last live width still gets committed/persisted, however the drag ends.
- **Result (verified):** New `nextDragState` test (`preview-pane.test.ts`) pins the exact
  transition that was missing (`cancel` while dragging → not dragging). `tsc --noEmit` and the
  full suite (150 files / 1494 tests) pass. Not manually reproduced in a live browser session
  (pointercancel needs a real OS-level interruption to trigger) — the fix targets the confirmed
  code-level gap (no cancel/lost-capture handler existed at all), not a guessed cause.

---

### 2026-07-28 — Composer and idea-capture textareas felt cramped on a small chat window

- **Symptom:** Owner observation — the text box inside the chat window reads as a fixed box, and
  on a small chat window the scrollbar it shows eats into that box, so it doesn't feel like all
  of the box's real estate is being used. Same complaint for the idea-capturing box.
- **Surface area:** `src/components/Composer.tsx`, `src/components/IdeaMicTab.tsx`.
- **Root cause (two distinct issues, one per box):**
  1. `IdeaMicTab`'s draft textarea was a **fixed `rows={2}`** with no auto-grow — unlike the
     composer, it never got taller than two lines. A kid's dictated idea running past that (very
     common — the coach's own demo line is a full sentence) triggered a native scrollbar almost
     immediately, well before the card had any real shortage of space around it.
  2. Both textareas used the **default OS scrollbar** once they did overflow (`overflow-y-auto`
     on the composer; the browser's implicit textarea scrollbar on the idea box). At the default
     15-17px width, that reads as a chunk of the box turned into dead gray space rather than "the
     box is full."
- **Fix:**
  1. `IdeaMicTab`'s textarea now auto-grows with the draft (same pattern as `Composer.tsx`'s
     existing `MAX_TEXTAREA_PX` effect) up to `MAX_DRAFT_TEXTAREA_PX` (120px, ~5-6 lines) before
     it scrolls, instead of clamping at 2 rows.
  2. Both textareas now use a thin, minimal scrollbar — `scrollbarWidth: "thin"` (Firefox) plus
     Tailwind arbitrary `[&::-webkit-scrollbar]` variants (WebKit) styled with the same neutral/
     brand tokens already used in each surface — so the rare case that still overflows doesn't
     read as wasted space either.
- **Result (verified):** `tsc --noEmit` and full suite (146 files / 1450 tests) clean (no new
  test surface — this is layout/CSS, not logic). Visual pass: headless-browser screenshots at a
  390px mobile width, typing 6 lines into each box — the idea box now shows 3+ lines comfortably
  before scrolling (was ~2), and the scrollbar in both boxes is a thin brand/neutral-toned bar
  instead of the full OS default.
- **Prevention:** n/a — UX polish, not a bug class.
- **Related:** none.

### 2026-07-27 — Idea mic capture silently dropped by a verify/repair cover

- **Symptom:** Owner report — a kid taps the Idea button and starts speaking; if the update
  already in flight finishes while they're mid-sentence, the idea just vanishes with no trace.
- **Surface area:** `src/components/IdeaMicTab.tsx`, `src/components/ArtifactFrame.tsx`,
  `src/components/ChatPanel.container.tsx`, `src/lib/idea-mic.ts`.
- **Root cause:** `ArtifactFrame`'s verify/repair cover (`covered = state.phase !== "done"`)
  unmounts `IdeaMicTab` whenever it comes up (`{!covered && onCaptureIdea && <IdeaMicTab .../>}`).
  Per `usePreviewVerify.ts`, that cycle restarts on **every** html change — not just the first
  generation, so any tweak-triggered rebuild could interrupt a capture, not only a brand-new game.
  The tab's own unmount cleanup called `discardAndStop()` unconditionally, discarding whatever
  transcript was mid-capture but not yet committed via "Next idea"/"Done."
- **Fix (owner explicitly rejected auto-committing the interrupted text — mid-cutoff speech is
  often a fragment, and queuing it unreviewed risks a build attempt on garbage; wanted it staged
  for the kid to review/edit instead, reusing the tab's existing editable review bar rather than
  building a new surface):**
  1. `IdeaMicTab`'s unmount cleanup now reads the live transcript via a ref (the previous effect
     had `discardAndStop` — stable, empty deps — as its only dependency, so its cleanup closure
     was fixed at mount time and would only ever have seen the EMPTY initial draft; a plain
     closure read here would have been the exact same class of stale-closure bug named in
     CLAUDE.md §9.2) and hands it up via a new `onInterrupted(text)` prop instead of discarding it.
  2. The parent (`ChatPanel.container.tsx`) holds it in `pendingIdeaDraft` state, which survives
     the tab's unmount/remount cycle, and passes it back down as `pendingDraft`.
  3. On the tab's next mount, `pendingDraft` restores straight into the *existing* editable
     listening/review bar (`initialMicTabState`, `lib/idea-mic.ts`) and resumes listening so
     speech keeps appending onto it — the kid sees exactly what they said and can edit, continue,
     finish, or discard it themselves via the same Next idea/Done/Never mind choices, never
     auto-queued and never silently dropped. `onDraftConsumed()` clears the parent's copy once
     picked up so a later, unrelated remount can't replay stale text.
- **Result (verified):** New `idea-mic.test.ts` cases for `initialMicTabState` (opens into
  "listening" with a non-empty pending draft, stays "tucked" on empty/whitespace/absent). Full
  suite (146 files / 1450 tests, 1 pre-existing skip) + `tsc --noEmit` clean.
- **Prevention:** Class — **an unmount driven by unrelated app state (here, a verify/repair
  cycle) must never be the only path that decides whether in-progress user input survives.**
  Any future overlay/cover that conditionally unmounts an input-capturing component needs the
  same hand-off-not-discard treatment, and any effect reading component state inside its cleanup
  must do so via a ref if the effect's own deps could leave that cleanup closure stale.
- **Related:** none prior in this surface; first instance of this class here.

### 2026-07-27 — Full-screen preview toolbar ate real estate for controls kids barely touch there

- **Symptom:** Owner observation — in full-screen preview, the top 2-3 bars (tabs, idea-queue
  chip, Invite, Publish, Full Screen toggle, Close, plus a second bar for the device switcher/
  Rotate) took up a lot of vertical space, while the two things kids actually touch there are the
  floating Idea mic tab and Exit Full Screen.
- **Surface area:** `src/components/ArtifactFrame.tsx` (UX improvement, not a regression — no
  prior behavior was broken; `expanded` never varied header layout before this change).
- **Fix:** When `expanded` is true, the header collapses to one thin bar — Exit Full Screen
  (prominent) + a "•••" overflow menu holding everything else (Preview/Code/Console tabs, device
  switcher + Rotate, Invite, Publish, idea-queue chip, Close). Split view (`expanded` false) is
  unchanged. Menu closes on an outside click/tap or on picking a tab (device/Rotate/Invite/
  Publish stay open — a kid comparing device sizes, or an action about to open its own modal
  anyway, shouldn't also lose the menu). Scoped to desktop full screen only, matching what was
  reported; mobile's always-full-width panel layout is untouched.
- **Result (verified):** `tsc --noEmit` and full suite (146 files / 1450 tests) clean; no new
  regression risk to split-view/mobile since that JSX branch is unchanged, just reused via shared
  `tabsGroup`/`deviceSwitcher`/`inviteButton`/`publishButton` consts instead of being duplicated.
  Visual pass (headless-browser screenshots, desktop 1440px + mobile 375px, seeded chat/game via
  localStorage — no live Gemini call needed) caught one real issue before it shipped: the new
  overflow menu and `IdeaMicTab`'s first-run coach popup are both `z-30`, and the coach popup
  renders later in the DOM (inside the preview area, after the header) — so on equal z-index it
  was painting on top of and obscuring the open menu. Fixed by raising the menu to `z-50`, which
  is above every other in-panel overlay; confirmed fixed by re-shooting the same screenshot.
- **Prevention:** n/a — UX improvement, not a bug class.
- **Related:** none.

---

### 2026-07-27 — Unnecessary full-rebuilds on ordinary small edits (KNOWN_BUGS #5 class fix)

- **Symptom:** Investigated at the owner's request by pulling 32 real full-rebuild trigger events from prod logs (`~/kidgemini/logs/app.log`) and matching each to the actual kid request in `usage_events`. 84% of the triggers were `search_not_found` on genuinely SMALL asks — "the tank colour don't provide better visibility," "the road corners... looks inverted," a request to let the player enter a building — not big rewrites. Every one of those forced a full, expensive, risk-of-regression rebuild instead of a small patch.
- **Surface area:** `src/lib/repair-prompt.ts` (`applyPatch`), `src/lib/gemini.ts` (`GAME_BUILD_CONTRACT`), `src/lib/game-edit.ts` (`GAME_EDIT_PROMPT_SECTION`).
- **Root cause:** `applyPatch` located the model's `SEARCH` text with plain, byte-exact `indexOf()` — the system prompt tells the model to copy that text "EXACTLY, character for character" from a large file it's reproducing from context, not reading verbatim. Any whitespace-only slip (an extra space, different indentation, a dropped trailing space) made the match fail completely, and a failed patch escalates straight to a full-game regeneration — the expensive, riskier path (BUG-FIX-LOG 2026-07-18 "penguin-maze": full rewrites regress untouched parts of the game).
- **Fix (two complementary changes):**
  1. **Whitespace-tolerant fallback matching** (`applyPatch`/`locateSearchText`, `repair-prompt.ts`): when the byte-exact search finds nothing, retry against both strings with whitespace collapsed (leading/trailing trimmed per line, internal runs of whitespace reduced to one space) — every non-whitespace character still has to match exactly, so this only forgives formatting drift, never lets a genuinely different SEARCH text through. Ambiguity (two normalized-identical spots) still fails closed with `search_ambiguous`, same as the exact path always has.
  2. **Landmark comments** (`GAME_BUILD_CONTRACT`, `GAME_EDIT_PROMPT_SECTION`): the model is now told, at BUILD time, to sprinkle short, distinct comments above each logically separate part of the game (`// --- PLAYER MOVEMENT ---`, `<!-- SCORING -->`, etc.), and at EDIT time, to anchor its SEARCH block on a nearby landmark plus a few lines rather than quoting a large block of gameplay logic from memory. A short label has far less surface area for a transcription slip than the code itself. This only helps games built after this change ships — existing games have no landmarks yet.
- **Result (verified):** New `repair-prompt.test.ts` cases (collapsed-whitespace-run match, re-indented multi-line match, dropped-trailing-space match, still fails on genuinely different text, case-sensitivity preserved, ambiguous-after-collapsing still fails closed, exact match still wins over fuzzy when both exist) + new prompt-pin tests in `gemini.prompt.test.ts` and `game-edit.test.ts`. Full suite (146 files / 1447 tests) + `tsc --noEmit` clean.
- **Impact:** Small, ordinary edit requests should now patch cleanly far more often instead of triggering a full, riskier rebuild — directly targets the dominant (84%) real-world cause found in prod logs. Games built going forward also carry landmark comments, which should compound the improvement over time as more of the fleet has them.
- **Prevention:** Class — **when an automated match against LLM-reproduced text has zero tolerance for formatting drift, the failure mode isn't "ask more precisely," it's "any transcription slip nukes the whole result."** Any future exact-match-against-model-output mechanism should default to whitespace-tolerant matching unless there's a specific reason letter-for-letter formatting must be preserved.
- **Related:** `KNOWN_BUGS.md` #5 (this doesn't close it — the asset-marker/head-spanning residual is a different, narrower mechanism — but reduces the OVERALL rate of unnecessary full rebuilds this bug's investigation was really about).

---

### 2026-07-27 — A parent who forgot their PIN had no way back in — round two (email OTP replaces the SSO-freshness gate)

- **Symptom (what the user saw):** Owner review of the fix directly below this entry — "This way,
  it is easy for kids to change it themselves." The first fix (below) made resetting a forgotten
  PIN reachable and discoverable, which was correct, but it exposed a pre-existing weakness in
  what "reachable" actually required: `POST /api/parent/pin` only checked that the SSO session was
  signed in within the last 5 minutes (`isFreshSession`). On a shared family device, a kid can
  satisfy that with no secret only the parent has — a cached Google login re-authenticates with
  one tap and no password prompt, or a browser-saved password autofills. The original PRD
  (`Ariantra-Platform/docs/PRD-PARENT-AUTH-ALERT-SCOPING.md` §7) had explicitly named and *accepted*
  this exact gap in 2026-07-10. Making the reset path more visible (the fix directly below) didn't
  create the hole, but it made a kid far more likely to find and use it — a locked-out kid now saw
  an inviting "Reset your PIN now" button leading straight to a gate they could pass.
- **Surface area:** Game repo — `src/app/api/parent/pin/route.ts` (freshness check removed, OTP
  check added), new `src/app/api/parent/pin-otp/request/route.ts`, `src/lib/parent-pin-otp.ts`
  (new, pure), `src/lib/parent-pin-otp-bridge.ts` (new), `src/lib/db.ts` (`parent_pin_otp` table +
  `SqliteParentPinOtpStore`), `src/types/parent-auth.types.ts` (new OTP types),
  `src/lib/ariantra-session.ts` (`isFreshSession`/`FRESH_SESSION_MAX_AGE_S` deleted — no longer
  called anywhere), `src/app/parent/page.tsx` (OTP step in the set/reset UI). Deleted:
  `src/lib/parent-pin-flow.ts` + test — the reauth-redirect resume mechanism built in the entry
  below only existed to survive the freshness gate's forced re-login; removing the gate removed
  the redirect entirely, so that machinery had no callers left. Platform repo (cross-repo, same
  server-to-server pattern as the Sparks bridge) — `src/lib/auth/email.ts` (`sendParentPinOtp` +
  `EMAIL_SUBJECTS.parent_pin_otp`), `src/lib/email/recording-email-sender.ts` (wraps it, code
  handled as a live credential — never logged, same as a password-reset link), new
  `src/app/api/studio/partner/parent-pin-otp/route.ts` (`x-admin-secret` gated), `src/test/fakes.ts`
  (`fakeEmailSender`/`makeContainer` extended), `src/types/email-log.types.ts` (`EmailKind` gains
  `'parent_pin_otp'`). `docs/PRD-PARENT-AUTH-ALERT-SCOPING.md` updated (v4 → v5) — the "accepted"
  limitation is marked wrong, not silently dropped.
- **Root cause:** A login-freshness check is not a second factor — it's the SAME factor (whatever
  already authenticated the browser) measured again, so anything that keeps that authentication
  alive (a cached OAuth session, a saved password, an unlocked device) satisfies it with nothing
  new. The class this belongs to: **treating "recently re-authenticated" as proof of intent is only
  as strong as how re-authentication actually happens** — for a password/OTP login it's a real
  barrier, for silent-SSO or autofill it barely exists. A real step-up factor has to require
  something the current session doesn't already carry.
- **Fix (class level):** Owner decision (explicit trade-off presented, not made unilaterally, per
  CLAUDE.md §7.1's no-clear-winner rule): the OTP **replaces** the freshness gate rather than
  stacking on top of it — stacking would keep the exact hole open on a device where the freshness
  check already silently passes. `POST /api/parent/pin-otp/request` (any signed-in session, no
  freshness requirement — the OTP itself is the proof) emails a 6-digit code to the SSO session's
  own address; `POST /api/parent/pin` now requires `{ pin, otp }` and verifies the code
  (`verifyOtpAttempt` — 10-min expiry, 5-attempt budget, single-use, fails closed on
  not-requested/expired/spent) before writing the new PIN hash. Send-side abuse controls
  (`canRequestOtp`): 60s resend cooldown, 5-per-24h rolling cap, and the send slot is only
  persisted once the platform bridge confirms delivery — a failed send can't burn a parent's
  cooldown for nothing. Applies uniformly to first-time set AND reset (one code path, and it also
  closes a smaller pre-existing gap: previously ANY signed-in-fresh session — even a kid's, if
  timed right — could set a family's very first PIN with zero extra proof). The parent-facing UI
  gained one deliberate step (request code → check email → enter code + new PIN) but LOST the old
  forced re-login redirect entirely, since the OTP no longer depends on session freshness — net
  simpler for a legitimate parent, not just more secure.
- **Result (verified):** New `parent-pin-otp.test.ts` (18 tests: code format, hash never contains
  the plaintext, cooldown/daily-cap window math, single-use verify state machine including the
  "spends the last attempt" edge case), `parent-pin-otp-bridge.test.ts` (3), `pin-otp/request/route.test.ts`
  (6: no freshness required — pins the fix directly — cooldown 429, failed-send doesn't burn the
  slot, code never returned to the client), `pin/route.test.ts` rewritten for the OTP contract (9,
  was 6). Platform: `recording-email-sender.test.ts` +1 (OTP recorded as metadata only, code never
  stored), new `parent-pin-otp.integration.test.ts` (5: auth, validation, send, code never in the
  response). Full suite both repos: Game 146 files / 1438 tests + `tsc --noEmit` clean; Platform
  115 files / 1028 tests + `tsc --noEmit` clean. Not walked through live in a browser with real
  SMTP delivery — dev environment has no mail credentials; the dev `EmailSender` logs the code
  instead, which is how local UAT would read it.
- **Impact:** A parent can still recover a forgotten PIN without contacting support, but doing so
  now requires reading an email only they receive — a kid sharing the device, however locked-out
  or however visible the reset button, cannot complete it without that access.
- **Prevention:** Class — **"the user is already logged in" and "the user re-authenticated
  recently" are not the same claim, and a security review of an auth flow must ask which one an
  SSO-freshness check actually proves** — silent/cached SSO makes them the same thing in practice.
  Any future step-up-auth requirement (payment confirmation, account deletion, contact-info change)
  on this or the platform repo should default to a channel-based proof (email/SMS OTP) over a
  freshness re-check, unless the login method itself always demands a fresh secret (password/OTP,
  not OAuth-with-remembered-session).
- **Related:** the entry directly below (2026-07-27, same day) — that fix was correct on
  discoverability and is NOT reverted; this entry replaces its underlying auth mechanism only.
  `Ariantra-Platform/docs/PRD-PARENT-AUTH-ALERT-SCOPING.md` "Changed since v4" (the owner-facing
  version of this record) and its §7/§12 inline supersession notes.

---

### 2026-07-27 — A parent who forgot their PIN had no way back in

- **Symptom (what the user saw):** Owner report — "there is no way to reset parents pin now." A
  parent who forgot their 4-digit PIN, or got locked out after 5 wrong guesses, had no visible
  path forward on `/parent`: the verify screen's only link was "First time here? Set your PIN →",
  which reads as *not for me, I've had a PIN before* and is easy to miss/distrust. Worse: even a
  parent who found it and tried to save a new PIN almost always hit `stale_session` (reset
  requires a login within the last 5 minutes, and the 30-day cookie means most visits aren't
  fresh) — clicking "Sign in again" bounced them to the platform login and back, but the return
  trip landed on a fresh page load with no memory of what they were doing, which re-ran the normal
  verify gate and put them right back at "Enter your parent PIN" — the exact PIN they'd just said
  they forgot. There was no way to escape that loop from the UI.
- **Surface area:** `src/app/parent/page.tsx`; new `src/lib/parent-pin-flow.ts`. No backend
  change — `POST /api/parent/pin` already treats set and reset as the identical write, gated only
  by `isFreshSession` (`src/lib/ariantra-session.ts`); the capability existed, the UI just
  couldn't reach it.
- **Root cause:** Two compounding gaps, both discoverability/state, not auth logic: (1) no
  explicit "Forgot your PIN?" affordance, and nothing at all offered during a lockout, so a
  panicking parent had no obvious next step; (2) the reauth round trip (`signIn({reauth:true})` →
  platform login → redirect back to `/parent`) carried no memory of "I was mid set/reset" — the
  parent page's only state is in-memory React state, which a full navigation away and back always
  discards, so the page fell through to its default first-load path (verify gate) regardless of
  why the parent had left.
- **Fix (class level):** Round-trip the in-flight intent through the URL itself, since that's the
  one thing survives a full-page navigation to another origin and back.
  `parent-pin-flow.ts` (pure, fully tested) exports `markPinFlowResume(href, mode)` — stamps
  `?parentPinFlow=set|reset` onto the current URL — and `consumePinFlowResume(href)`, which reads
  and strips it, failing closed to `null` on anything not exactly `"first-time"|"reset"`. Before
  calling `signIn({reauth:true})`, the "Sign in again" button now stamps the current URL with the
  mode the parent was already in (`reauthAndResume`); on mount, `/parent` consumes that param
  first and — if present — jumps straight to the `set` screen in that mode, skipping the
  verify/alerts fetch entirely (a parent resuming a reset has nothing to verify against; asking
  them to re-enter the forgotten PIN would recreate the exact dead end). Separately, the verify
  screen now has a standing "Forgot your PIN?" link next to (not replacing) "First time here?",
  and a lockout (`429`) renders its own `warn-50` recovery callout — "You don't have to wait —
  resetting your PIN works right away" — instead of a plain red error line, since reset is
  never blocked by the verify-attempt lockout (they're independent gates by design).
- **Result (verified):** New `parent-pin-flow.test.ts` (7 tests: param round-trip preserves other
  query params/hash, overwrite not duplicate, strips cleanly, fails closed on an unrecognized
  value). Full suite green — 144 files / 1409 tests + `tsc --noEmit` clean. Dev server boots and
  serves `/parent`; the authenticated interactive states (verify/locked/set with a live SSO
  session) were reviewed in code and via typecheck but not walked through in a live browser — that
  needs a real platform login round trip this sandbox doesn't have credentials for. Flagging this
  explicitly rather than claiming a visual UAT pass that didn't happen.
- **Impact:** A parent who forgets their PIN, or gets locked out, now has an obvious, always-visible
  way back in that actually completes — no more silent dead end at the one screen that requires
  the very thing they don't have.
- **Prevention:** Class — **a client-only navigation flow (redirect-out-and-back-in for reauth)
  must carry its own intent, because full-page navigation discards all in-memory state.** Any
  future flow that bounces a user off-site and back (payment redirects, OAuth, age-gate) needs
  the same treatment: round-trip the resume intent through the URL/returnTo, don't assume the app
  will "remember" why the user left.
- **Related:** none prior in this repo; first entry for the parent-PIN reset path.

---

### 2026-07-27 — A ~100K-char edit turn (re-attached game file) hard-blocked by the profanity/self-harm rules

- **Symptom (what the user saw):** `KNOWN_BUGS.md` #7 — an edit turn arrived with `chars=100403` and was `input-rules action=hard_block`ed in 29ms with no meaningful `triggerText`, just game source. Distinct from the same-day HARASSMENT:LOW block (that one is Gemini's own provider-side safety layer); this is the app's own deterministic `RulesClassifier` pre-check.
- **Surface area:** `src/components/ChatPanel.container.tsx` (`handleSend`, `runStream`), `src/app/api/chat/route.ts`, `src/lib/safety.rules.ts`.
- **Root cause:** `ChatPanel.container.tsx`'s `apiMessage` construction folded an ENTIRE text attachment's content into the same string sent as `message` whenever the attachment fell through `file-open.ts`'s complete-HTML-document check (e.g. a re-attached `.js`/partial-HTML game file). `route.ts` then ran `rules.classifySync({ text: message, ... })` over that whole folded string — so a re-attached ~100K-char game got scanned by the SELF_HARM whole-string substring check and the PROFANITY per-token scan as if it were 100K characters of typed child speech, dramatically raising the odds of an accidental hit (same class as the fixed "medic kit"→"medickit" bug, 2026-07-18, but ~100x the text volume).
- **Fix:** Attachment content now travels as its own field (`attachmentText`/`attachmentName`), never folded into the child-typed `message`/`text`. Server-side, `route.ts` reconstructs the identical model-facing prompt (`childText` + the file wrapper) for the actual Gemini call — model behavior is unchanged — but `rules.classifySync` now scans `childText` (the child's own typed words) ONLY. Defense-in-depth backstop added in `safety.rules.ts`: `MAX_SELF_HARM_SCAN_CHARS` (4000) bounds the previously-unbounded SELF_HARM whole-string check, so any future path that accidentally sends an oversized message degrades to "scan the first 4K chars" instead of guaranteed false-positive surface across the whole thing (PROFANITY was already per-token-safe, unchanged).
- **Result (verified):** New `safety.rules.test.ts` cases (ceiling backstop, still catches genuine phrases within it, doesn't false-positive on huge benign payloads) + new `route.test.ts` describe block reproducing the exact case (asserts `classifySync` is called with only the short instruction, and that the model still receives the full attachment content unchanged) + a same-block test confirming a genuinely blockable typed instruction still hard-blocks regardless of attachment. Full suite (144 files / 1416 tests) + `tsc --noEmit` clean.
- **Impact:** Kids can re-attach/re-share a large game file without the turn being silently hard-blocked; the safety floor for actual typed child speech is unchanged.
- **Prevention:** Class — **a deterministic child-safety scanner's input must be scoped to what the child actually typed, never to app-forwarded payloads (file contents, game state, upload bodies) that happen to travel through the same field.** Any future "fold X into the message string" shortcut needs its own field instead.
- **Related:** `KNOWN_BUGS.md` #7 (now FIXED); `2026-07-27_PRD_AssetHeadReconcileAndProfanityGate.md` Part 2; the 2026-07-27 "Mega Evolution" entry (the sibling, provider-side SAFETY block this is NOT).

---

### 2026-07-27 — KNOWN_BUGS #5 closeout Step 0: `inSource=false` misses now self-classify from the log alone

- **Symptom:** none kid-facing yet — this is instrumentation, not a behavior change. `KNOWN_BUGS.md` #5's residual (a SEARCH block spanning the injected `<head>` still can't be reconciled by marker-stripping alone) needed real prevalence data before committing to the bigger structural fix (patch against a pre-injection copy of the HTML), and today's `afterMarkerStrip=false` log line was ambiguous — it couldn't distinguish "head-spanning residual" from "a genuinely different stored version."
- **Surface area:** `src/lib/game-edit.ts` (new `reconcileAssetMarkersWithReason`, `ReconcileBailReason`), `src/app/api/chat/route.ts` (`logSearchMiss`).
- **Change:** `reconcileAssetMarkers` now delegates to a reason-returning variant that pins exactly which of its three guards tripped (`not-injected` | `new-asset` | `no-marker`) instead of just returning `null`. `logSearchMiss` logs two new fields: `searchSpansHead` (does the model's SEARCH text contain `<head`, `type="importmap"`, or `AR_ASSETS`?) and `reconcileBailed=<reason>` (or `rescued` when reconciliation succeeded). A prod `inSource=false afterMarkerStrip=false searchSpansHead=true` streak now conclusively confirms the head-spanning residual from the log alone, per the closeout plan in `KNOWN_BUGS.md`.
- **Result (verified):** `game-edit.reconcile.test.ts` A.1–A.7 unchanged (still passing — the existing export's behavior is untouched) + 5 new cases pinning each bail reason and confirming `reconcileAssetMarkers`/`reconcileAssetMarkersWithReason` still agree. Full suite (144 files / 1416 tests) + `tsc --noEmit` clean.
- **Impact:** none yet — sets up the measurement step. `KNOWN_BUGS.md` #5 stays WATCHING pending a few days of real 3D-edit prod traffic; only if the head-spanning case proves common does the Step 4 structural fix (see `2026-07-27_PRD_AssetHeadReconcileAndProfanityGate.md` Part 1) get built.
- **Related:** `KNOWN_BUGS.md` #5; `2026-07-27_PRD_AssetHeadReconcileAndProfanityGate.md` Part 1.

---

### 2026-07-27 — "Buy Sparks" on ariantra.com landed on the old yearly-plan checkout, not Sparks packs

- **Symptom (what the user saw):** Owner report — clicking "Buy Sparks" on `ariantra.com/pricing.html` → login → `/upgrade` showed Explorer ₹1,200/yr, Assisted Starter ₹3,990, Assisted Pro ₹10,000: the pre-relaunch yearly plans, nothing to do with the ₹120/₹200/₹500 Sparks packs the pricing page actually sells.
- **Surface area:** `src/lib/billing.config.ts`, `src/app/api/billing/{order,verify,webhook}/route.ts`, `src/components/UpgradePlans.container.tsx` + `PlanCard.tsx`, `src/app/upgrade/page.tsx`; new: `src/lib/sparks-bridge.ts` (`creditPurchase`), `src/lib/ariantra-session.ts`/`auth-identity.ts` (`playerId`/`resolvePlayerId`), `src/lib/db.ts` (`payments.playerId` column) — plus platform repo's `sparks.types.ts`, `sparks-service.ts`, `partner/sparks/route.ts`.
- **Root cause:** the July 25/26 Sparks relaunch shipped the marketing copy and the Sparks ledger (grants, metering) but never built the actual top-up payment flow — the July 25 launch note (`../Ariantra-Platform/docs/TECH_DEBT.md` #80) explicitly parked this, and the decided interim (route "Buy Sparks" to WhatsApp) was never wired into the live CTA — it kept pointing at Ari's pre-existing `/upgrade` Razorpay checkout, still selling the plans it was originally built for.
- **Fix (Phase 5 payments, cross-repo):** `SPARK_PACKS` replaces `BILLING_PLANS` (`pack120`/`pack200`/`pack500` → 12k/20k/50k ⚡, pinned by `billing.config.test.ts`). `/api/billing/order` creates the Razorpay order for a pack exactly as before (server-computed amount, never client-trusted). On a verified payment, `/api/billing/verify` (fast UI confirm) and `/api/billing/webhook` (source of truth) both call the platform's Sparks ledger via a new `purchase` action on `/api/studio/partner/sparks` — server-to-server, same trust pattern as the existing `inviteCredit` action (`x-admin-secret` only, explicit `playerId`, no live session needed), because the webhook has no browser session to replay. The `playerId` (the platform's real ledger key, distinct from this repo's derived `userId`) is captured at order-creation time — when a session genuinely is live — and stored on the payment record (`payments.playerId`, new column, migrated via the existing `ALTER TABLE IF NOT EXISTS` pattern) for the webhook to use later. Idempotent on `razorpayPaymentId` (the ledger's dedup key), so verify and webhook never double-credit the same payment. **Money-safety asymmetry, deliberate:** verify degrades gracefully on a bridge failure (`pending: true` — the payment DID succeed, never tell a paying user otherwise); webhook THROWS on the same failure, so Razorpay's own automatic webhook retry keeps trying until the credit lands.
- **Model change:** Sparks packs are metered top-ups, not time-based entitlements — `periodEndsAt` is now always `null` for every plan key (old yearly plans are gone; nothing on the live site linked to them). `isEntitled`/`entitlement-service.ts` (the dormant, `RELAXED BY DEFAULT` multiplayer gate) is now permanently false if ever enforced — harmless today (see `../Ariantra-Platform/docs/TECH_DEBT.md` #84), needs a Sparks-era redesign before that flag is ever flipped.
- **Result (verified):** Full suite green in both repos — Game 143 files / 1397 tests + `tsc --noEmit` clean; Platform 114 files / 1022 tests + `tsc --noEmit` clean. New/extended coverage: `sparks-service.test.ts` + `sparks.integration.test.ts` (idempotent credit, malformed-shape 422, no-auth 403); Game's `billing.config.test.ts`, `sparks-bridge.test.ts`, `order/verify/webhook route.test.ts` (pack amounts server-computed, bridge called with the right idempotency key, webhook re-throws on bridge failure, verify never reports a successful payment as failed), `ariantra-session.test.ts` (playerId exposed), `db.payments.test.ts` (real-sqlite round-trip, `latestForUser` still excludes the custom-amount sentinel). Visual pass done at desktop + 375px mobile.
- **Impact:** "Buy Sparks" now sells what it promises. A parent can top up Sparks with the same trusted checkout Ari already had, and the credit lands reliably even if the browser closes right after paying.
- **Prevention:** Class — **a marketing CTA that points at a payment surface is a promise about what that surface sells; when the pricing model changes, the checkout has to ship in the SAME release, not as a parked follow-up.** `../Ariantra-Platform/docs/PRD-SPARKS.md`'s "Payments (v2)" now says "shipped 2026-07-27", and `TECH_DEBT.md` #80 is closed.
- **Related:** `../Ariantra-Platform/docs/BUG_LOG.md` #45 (platform-side mirror of this entry); `TECH_DEBT.md` #80 (the original parked gap), #84 (new — the dormant entitlement-service consequence this change surfaced).

---

### 2026-07-27 — A kid's battle-game edits repeatedly blocked with the generic "tangled me up" retry

- **Symptom (what the user saw):** A signed-in child asked Ari to add a "Mega Evolution" mechanic to his Pokémon-style creature-battle game. Every attempt — including rewordings ("super Evolution", framed around a trainer/gym/wild-creature battle) — returned `MODEL_GLITCH_RETRY` ("Hmm, that one tangled me up! ✨"). Signing out and back in changed nothing.
- **Surface area:** `src/lib/gemini.ts` (`GeminiChatModel.buildContents`/`replyStream`), `src/lib/persona/persona.ts` (`CHILD_SAFETY` thresholds, unchanged), `src/app/api/chat/route.ts` (`SafetyBlockedError` path, unchanged).
- **Root cause:** Investigated live via prod pm2 logs + the `alerts` table (`sqlite3 ~/kidgemini/data/kidgemini.db`). Input rules passed every ask (`action=allow`); SSO/auth was fine (`userId=user:…` on every turn). Each turn instead ended with Gemini's own `finishReason: SAFETY`, attribution `[HARASSMENT:LOW, HATE_SPEECH:NEGLIGIBLE, SEXUALLY_EXPLICIT:NEGLIGIBLE, DANGEROUS_CONTENT:NEGLIGIBLE]` — a misread of ordinary battle-game language (trainers, gyms, rivals) at the child persona's strictest HARASSMENT threshold (`BLOCK_LOW_AND_ABOVE`). Edit turns resend the whole game (~100K chars in this case), so no rewording of the *ask* could ever clear it — confirmed live when a differently-worded retry still blocked. Live-verified fix signal: prefixing the identical ask with "I am a game designer" / "for a kids educational game" context cleared the block (rating dropped to NEGLIGIBLE) — the classifier reads user-turn framing, not just content.
- **Fix (class level):** Rather than relax the HARASSMENT threshold for all child content (considered, rejected — a real posture change, and precedent from 2026-07-23 shows a targeted fix works), `gemini.ts` now injects a new `CHILD_BUILDER_CONTEXT` string as its own leading part of the final user turn — never merged into the child's own words — for CHILD-persona game-**build** turns only (`isGameBuildTurn`, from `builder-mode.ts`, already covers "new game" asks and edits of an existing artifact). Ordinary chat and the verified-adult bible-teacher persona (which has its own relaxed thresholds) are untouched. No safety-posture change: every `safetySettings` threshold is exactly what it was before (`gemini.safety-config.test.ts`, `persona.test.ts` unchanged) — this only corrects Gemini's misreading of benign kid content, the same class of false positive as the 2026-07-22/23 HATE_SPEECH incidents.
- **Result (verified):** New `gemini.safety-context.test.ts` (6 tests) pins: child build turns get the injected context; the same build-turn detector fires on an edit with no "game" word (artifact in history); ordinary non-build chat is NOT injected; the bible-teacher persona is NOT injected; the context string itself asserts truthful designer/fiction framing. `gemini.contents.test.ts` gains 2 tests pinning the part layout (leading text part, image still rides after it, history never carries the injected text). Full suite (143 files / 1391 tests) + `tsc --noEmit` clean.
- **Impact:** Kids building genre-typical battle/adventure games no longer hit a dead-end retry loop with no way out; no kid ever needs to type "magic words" — the app supplies the truthful context server-side, on every qualifying turn, automatically.
- **Prevention:** Class — **a provider safety block on benign content is a context-framing problem, not necessarily a threshold problem.** When live evidence shows added truthful context clears a block, prefer injecting that context over relaxing the threshold — it fixes the root misread instead of widening what's allowed through.
- **Related:** BUG-FIX-LOG-class 2026-07-22 (HATE_SPEECH:LOW false positive on a Bible game, attribution logging added), 2026-07-23 (HARASSMENT:LOW false positive on a Bible-game edit, fixed via bible-teacher persona threshold — the precedent this entry deliberately does NOT repeat for the child default); `docs/KNOWN_BUGS.md` — separate, still-open false positive: a 100,403-char edit turn hard-blocked by the deterministic profanity rules (`safety.rules.ts`) scanning game source as if it were child speech.

---

### 2026-07-26 — "Open the file" on an uploaded game went to the model, which rebuilt it with hallucinated additions

- **Symptom (what the user saw):** Owner UAT: upload a game's HTML file, say "open the file" — instead of the preview simply showing the uploaded game, the request went to Gemini, which regenerated its own version of the game and added things that weren't in the file.
- **Surface area:** `src/components/ChatPanel.container.tsx` (`handleSend`), new `src/lib/file-open.ts`.
- **Root cause:** There was no open-the-file path at all. Every text-file upload took the one existing route — file contents folded into the prompt ("The child attached a file… Its contents: …") and sent to the model. The preview only ever renders what the MODEL returns, so "open it" could only ever mean "regenerate it": hallucination was structural, not a model mood.
- **Fix (class level):** Deterministic file-open, model excluded. `file-open.ts` (pure, fully tested): a complete HTML document (`isCompleteHtmlDocument`, same detection `extractArtifact` uses) plus an open-only/empty message (`isOpenOnlyRequest` — conservative word-set check; "open a shop in the game" still counts as an edit) → the file is inserted into the chat as a game message byte-for-byte and shown in the preview, with a local assistant line — **no model call**. A real change request opens the file the same way first, then sends the ask as an ordinary patch-edit against the opened game (history carries a stand-in upload line, not a copy of the typed text, so `isRepeatedRequest` can't misfire). Fragments/scripts (.js, partial HTML) keep the old model path — they can't render.
- **Result (verified):** `file-open.test.ts` (9 tests: document detection, open-intent vs edit-intent incl. the reported phrase, plan modes, repeated-request guard); game-edit + history-trim suites green; tsc clean. Live check: uploaded HTML opens byte-identical in the preview with zero model calls in the server log.
- **Impact:** Kids can bring a game file in and trust what opens IS their file; iterating from it uses the cheap patch path instead of a full rebuild (~10–15K input tokens saved per open).
- **Prevention:** Class — **an intent the app can satisfy deterministically must not be delegated to the model.** When the correct output is already sitting in local bytes, the model can only make it worse.
- **Related:** BUG-FIX-LOG 2026-07-18 search_not_found (artifactHtml-field game detection this reuses), PRD-PROMPT-CACHING.md (patch-path economics).

---

### 2026-07-24 — Typing any fresh message silently un-froze a stopped idea line

- **Symptom (what the user saw):** Found by design review during the Idea Queue v2 work (PRD-IDEA-QUEUE-V2), not reported by a kid — but live in v1 all day: stop a build → the queue freezes with "⏸ Still want these?" → type anything unrelated → after that turn finishes, the frozen ideas start building again even though the question was never answered. A second, same-class hole: on a restored chat, the drain effect could run once against its stale pre-pause closure (the pause was set by a sibling effect in the same commit) and fire a queued idea the instant the chat loaded — exactly what the "restored chats always ask" rule forbids.
- **Surface area:** `src/components/ChatPanel.container.tsx` (`handleSend` cleared `queuePaused` unconditionally; `queuePaused` initialized `false`), drain effect.
- **Root cause:** The pause was a bare boolean, so the code couldn't distinguish "paused because the chat was restored" (fine to clear on any kid action) from "paused because a turn was stopped/failed" (must keep asking). And the initial state was un-paused, leaving a one-commit stale-closure window on restore.
- **Fix (class level):** `QueueHold = "restored" | "failed" | null` (idea-queue.types.ts) replaces the boolean. `holdAfterKidAction` (pure, tested) clears only "restored"; a "failed" hold is cleared exclusively by the explicit "Yes — keep going ▶". Initial state is `"restored"`, killing the restore-drain race deterministically instead of racing the sibling effect.
- **Result (verified):** `idea-queue.test.ts` — `holdAfterKidAction` truth table + `drainDecision` holds for ANY QueueHold, busy or not; browser visual pass (restored 3-idea line asks first on desktop and via the preview sheet, resume drains). Full suite + tsc clean.
- **Impact:** Nothing generates unattended after a stop/failure without explicit consent — cost + trust guarantee, now structural.
- **Prevention:** Class — **a boolean flattening two states that need different clearing rules** (same family as fail-open defaults). When a "paused" flag has more than one cause, model the cause.
- **Related:** PRD-IDEA-QUEUE.md §3 (v1 owner decision this preserves), 2026-07-21 ✨ queue-while-busy entry (the mechanism v2 retires).

---

### 2026-07-24 — The queue drain could send the pre-edit text of the exact idea being fixed

- **Symptom (what the user saw):** Design-review find (same v2 pass): queue rows committed edits on BLUR. If the kid was mid-edit on row 1 at the moment the current build finished, the drain took the row's stored (pre-edit) text and sent it; the blur then committed into an id no longer in the line — the kid's correction vanished and the uncorrected idea got built.
- **Surface area:** `src/components/IdeaQueue.tsx` rows (was uncontrolled `defaultValue` + `onBlur`), drain effect in `ChatPanel.container.tsx`.
- **Root cause:** Commit-on-blur assumes the reader waits for the writer; the drain is an async consumer that doesn't. (The uncontrolled field existed to dodge the store's trim-or-noop rule snapping a controlled field back when briefly empty.)
- **Fix (class level):** Rows keep a local draft and commit upward on every NON-EMPTY change (`QueueRow` in IdeaQueue.tsx) — the store always holds current text, so any consumer reads the edit; the empty-draft case stays local (preserving the trim-or-noop protection), and external text changes (a cap-merge) sync in only while the row isn't focused.
- **Result (verified):** Full suite + tsc clean; visual pass exercises in-place edits. The same pattern was applied to the sheet variant for free (one component).
- **Impact:** An edit a kid is typing can no longer lose a race to the drain, on either surface.
- **Prevention:** Class — **commit-on-blur feeding an asynchronous consumer**. Anywhere a store value can be *consumed* while a field is focused, commit on change, not blur. (The Idea Bag's blur-commit rows, same pattern, were retired in this change.)
- **Related:** PRD-IDEA-QUEUE-V2 §3.6; the silent-resume entry above (same review).

---

### 2026-07-24 — The Game Stuff gallery told kids to say "3d strawberrys"

- **Symptom (what the user saw):** The asset gallery's trigger phrase for the strawberry model read **"3d strawberrys"**. Found while auditing plurals during the 106 → 159 catalog expansion, not reported by a user — but it is on a page built for children to read aloud.
- **Surface area:** `plural()` in `src/lib/assets/gallery.ts`, rendered into every model card's `trigger` by `galleryCards()` and shown on `src/app/assets/page.tsx`.
- **Root cause:** `plural()` was `IRREGULAR_PLURALS[name] ?? \`${name}s\`` — a hardcoded exception list (fish, police, hero, ice cream, man, woman) plus naive `+s` for everything else. English `-y` and already-plural nouns were never handled, so correctness depended on somebody remembering to add each new name to the list. The expansion made that failure mode concrete: `strawberry` → "strawberrys", and `cherries` → "cherriess" (a second instance the audit surfaced only because I went looking).
- **Fix:** Replaced the guesswork with rules, in `plural()`: already ends in `s` → unchanged; consonant + `y` → `-ies`; vowel + `y` → `-s` (so "keys"/"driveways" stay right); otherwise `+s`. The irregular list stays for genuinely irregular words and gained `businessman` → "businessmen" and `kimono woman` → "kimono women" from this batch.
- **Result (verified):** `src/lib/assets/gallery.test.ts` — new case pins `strawberry`→"strawberries", `cherries`→"cherries", `flats`→"flats", and that `key`/`driveway` are NOT changed; the existing people case extended to the two new compound names. Swept all 159 committed models afterwards: no remaining bad plurals. `npm run test` 1254 passing, `tsc --noEmit` clean.
- **Impact:** Cosmetic but kid-facing, on the one page whose entire job is teaching children the words to say. No behaviour change to model loading or the prompt catalog (`trigger` is gallery copy only).
- **Prevention:** Class — **a correctness rule implemented as a hand-maintained exception list**, so every new asset silently inherits the bug until someone notices. Same shape as the genre-membership arrays retired the same day (`asset-taxonomy.ts`). Guard: the new test asserts the *rules*, not four specific words, so future `-y` and already-plural models are right on arrival rather than needing a new list entry.
- **Related:** Same-day `asset-taxonomy.ts` migration (membership moved off hand-maintained arrays onto the assets); REGRESSION-TEST-CATALOG row for `gallery.ts`.

---

### 2026-07-24 — Publish showed the naming screen, took it away, then brought it back

- **Symptom (what the user saw):** Pressing 🚀 Publish in the preview showed **"Name your game!"** for a few seconds, then it was replaced by **"What are we doing? 🎮"**, and then the naming screen appeared *again* — three modals for one decision, reading as a broken/looping sheet.
- **Surface area:** `src/components/PublishToArcade.tsx` (step state machine), reached from the preview panel's Publish pill (`src/components/ArtifactFrame.tsx:305`).
- **Root cause:** The sheet **guessed** its first step. `useState<Step>("name")` rendered the naming screen immediately, while an async `POST /api/arcade/publish {list:true}` was still fetching the kid's existing games; when that resolved with ≥1 game the step flipped to `choose`. Picking "🆕 Publish a brand-new game" then returned to `name` — the screen the kid had already been shown and had taken away. Every kid with at least one published game hit this on every publish; the slower the list call, the longer the wrong screen sat there. (It also violated the no-blank/no-wrong-screen rule in CLAUDE.md §5 — a loading state was owed here.)
- **Fix:** Step sequencing moved into pure, unit-tested `src/lib/publish-flow.ts`. The sheet now opens on a new `loading` step (kid-styled skeleton: "Getting the launchpad ready… 🚀") and commits **once**, via `stepAfterGamesLoad()`: games → `choose`, none → `name`. That helper only moves the two steps that are actually waiting on the list (`loading`, and `signin` after the sign-in round trip), so a late or retried list response can never yank a kid out of naming, the PIN, or a running publish. The `catch` path now also resolves the step (previously it could strand the sheet) and still surfaces the existing "couldn't check your games — tap to retry" affordance.
- **Result (verified):** `src/lib/publish-flow.test.ts` (6 tests). Browser repro against the real UI with stubbed session/arcade routes, before: `["Name your game! 🎮", "What are we doing? 🎮"]`; after: `["Getting the launchpad ready… 🚀", "What are we doing? 🎮"]` — and `["Getting the launchpad ready… 🚀", "Name your game! 🎮"]` for a kid with no games. Re-verified with a deliberately slow (2.5s) list response: still no naming flash. `tsc --noEmit` clean.
- **Impact:** Publishing now asks exactly one question per decision. No change to the server gates (`/api/arcade/publish` still enforces auth, parent PIN, name/copyright checks) — this is purely which screen the kid is shown while the client learns what it needs.
- **Prevention:** Class — **rendering a step before the data that decides it has arrived** (guessed initial state instead of a loading state). Guard: `publish-flow.test.ts` pins `INITIAL_PUBLISH_STEP === "loading"` and that no in-progress step is ever overwritten by a late fetch. Same shape to watch for anywhere a modal picks its first screen from an async answer.
- **Related:** REGRESSION-TEST-CATALOG row for `publish-flow.ts`.

---

### 2026-07-23 — Sign-in on a local build escaped to production Studio, losing the local draft

- **Symptom (what the user saw):** In local dev the user built a game while logged out, then signed in via Google — and instead of coming back to `localhost`, they landed on `https://studio.ariantra.com` (Studio). The game they'd just made was gone.
- **Surface area:** `src/lib/useAriantraSession.tsx` (`signIn`/`verifyAge`), reached from the create-while-logged-out LoginGate (`src/components/ChatPanel.container.tsx`). Prod-side second barrier: platform `src/lib/auth/return-to.ts` (`safeReturnTo`).
- **Root cause:** `LOGIN_URL` was chosen from **build-time** `process.env.NODE_ENV` — `"development"` → localhost, everything else → `https://studio.ariantra.com/login`. A locally-served **production** build (`next start`) has `NODE_ENV === "production"`, so sign-in was sent to the prod platform even though the app was served from localhost. The prod platform's `safeReturnTo` then (correctly, as a security guard) rejected the `returnTo=http://localhost…` and fell back to `/studio` — so the user was both bounced to prod AND unable to return, and the local-only draft never existed there.
- **Fix:** Login origin is now resolved at **click time** from the live host, not NODE_ENV. New `src/lib/login-url.ts` (`resolveLoginUrl(hostname, envOverride)`): explicit `NEXT_PUBLIC_ARIANTRA_LOGIN_URL` wins → `localhost`/`127.0.0.1` → local platform `:3000` → else production. `useAriantraSession.tsx` now calls it with `window.location.hostname` inside `signIn`/`verifyAge` (age gate derived via `ageUrlFrom`). The prod-side `safeReturnTo` guard is left as-is — it is correct.
- **Result (verified):** `login-url.test.ts` L.1–L.5 (localhost→local incl. under a prod build, real host→prod, SSR→prod fail-closed, env override wins, age-gate host). `npx vitest run` green; `tsc --noEmit` clean.
- **Impact:** Anyone running/QA-ing a **local production build** of the chat app can now sign in without being thrown to production and losing their work. No change to real prod or `next dev` behaviour. No auth-model or cookie change.
- **Prevention:** Class — **build-time env leaking into a client runtime decision**. Guard: `login-url.test.ts` pins that the origin comes from the host, not NODE_ENV. Same `NODE_ENV`-switch pattern still lives in `src/components/ArNav.tsx`, `src/app/parent/page.tsx`, and platform `src/lib/ui/nav-links.ts` (outbound nav links, not the login redirect) — lower impact, not fixed here.
- **Related:** KNOWN_BUGS.md #6. Prior SSO returnTo work: platform BUG_LOG #12 (`return-to.ts`).

---

## When to add an entry

Add an entry **whenever a fix lands**, including:

- A bug surfaced by a user or UAT and fixed.
- A regression rediscovered (link the prior entry; say *why* the prior fix didn't hold).
- A **safety fail-open** or any "wrong-but-not-crashing" defect (easiest to miss — highest priority).
- A security / privacy / data-correctness fix.

You do **not** need an entry for: pure refactors, doc-only changes, dependency bumps, copy edits.

---

## Entry template

```markdown
### YYYY-MM-DD — <one-line headline>

- **Symptom (what the user saw):** …
- **Surface area:** files / routes / components affected
- **Root cause:** the actual mechanism (not the symptom)
- **Fix:** what changed, with file:line refs
- **Result (verified):** how we confirmed it (test names, UAT step, log excerpt)
- **Impact:** who's affected, what's now different (behaviour, data shape, safety posture)
- **Prevention:** the test/type/gate that will catch a regression; **name the class**
- **Related:** prior log entries of the same class, KNOWN_BUGS.md row #, commit hashes
```

---

## Entries

<!-- Newest first. Add new entries directly under this heading. -->

### 2026-07-23 — 3D games came out flat / black-screened ("said three.js, stayed 2D") — the "racing game" incident

- **Symptom (owner, live UAT, Hinglish):** built "mujhe ek racing game banana hai", then asked repeatedly for 3D ("isko 3D game Banega", "real 3D game nahi hai 3D cars use karna"). For ~10 turns the game stayed a flat 2D canvas with faked perspective; when it finally went Three.js it black-screened with `Uncaught TypeError: Failed to resolve module specifier "three"`, and the model "fixed" it forever without success.
- **Surface area:** `src/lib/assets/inject.ts` + new `runtime-helpers.ts` / `ensure-runtime.ts`; `src/app/api/chat/route.ts` (delivery + edit-branch guard); `src/app/api/repair/route.ts`; `src/components/ArtifactFrame.tsx` (preview srcDoc); `src/lib/gemini.ts` (stream mode); `src/lib/game-edit.ts` (`isThreeConversionTurn`); `src/lib/assets/prompt-catalog.ts` (prompt). New tests: `ensure-runtime.test.ts`, `game-edit.test.ts` C.1–C.5, `route.test.ts` C.R; updated P.1/L.1/L.2/L.4.
- **Root cause (two stacked defects; a third suspected cause was DISPROVEN):**
  1. **Missing import map (the crash).** `injectAssets` adds `<script type="importmap">{three: <engine-url>}</script>` — but it fires only on the `<!--USES_THREE-->` marker and only at chat delivery. When the model imported `"three"` but mis-placed/omitted the marker (observed: the turn-18 artifact had `import from "three"` and NO import map), nothing injected. `/api/repair` and the client preview never re-injected either, so the specifier stayed unresolvable and the repair loop could never win. (Verified by reading the stored chat artifacts: importmap absent at the first 3D turn; later turns carried a model-invented CDN import map the CSP blocks.)
  2. **Edit-patch fought the engine switch.** Every "make it 3D" was an EDIT turn patching the finished 2D canvas game. Converting 2D→Three.js is a whole-file rewrite, so a SEARCH/REPLACE patch made the model take the least-resistance path — fake depth with CSS/perspective on the 2D canvas — for ten turns.
  3. **DISPROVEN:** an earlier hypothesis blamed hallucinated model names (`tree`/`rock`). The manifest actually has 106 models INCLUDING tree, rock and coin — the names were real; they'd have loaded fine once `three` resolved. No fix built for a non-bug (test F.6 corrected to use a genuinely-unknown name).
- **Fix:**
  - **#1 marker-independent import-map floor** (`ensureAssetRuntime`, pure/non-server so it runs client-side too): whenever HTML uses three / calls `loadModel`, it guarantees exactly ONE import map → our engine (replacing any wrong/CDN map — never two), plus the `loadModel` helper + an `AR_ASSETS` table recovered from `loadModel("name")` call sites. Idempotent + 2D-safe. Wired into **all** paths per owner decision: chat delivery (belt-and-suspenders after injectAssets), `/api/repair` output, and the preview `srcDoc` (`ArtifactFrame`). Shared helper strings extracted to `runtime-helpers.ts` so the server injector and the floor can't drift.
  - **#2a rebuild-not-patch on 2D→3D** (`isThreeConversionTurn`): a 3D request on a 2D game streams a full REBUILD (Three.js), not a patch. Used at BOTH choke points — gemini.ts's stream `isEdit` and the route's patch guard — via one predicate so they always agree. **SUPERSEDED 2026-07-26 (owner decision):** the conversion no longer rebuilds in place at all — it answers with a "3D is a whole NEW game" info panel (one OK button) and builds the 3D game in a fresh chat seeded with the 2D source (`forceRebuild`), so the 2D game always survives. Same predicate, new route: `route.ts` §1b; tests D3.1–D3.3, C.R (updated), EE.9; FEATURES.md "2D→3D is a NEW game".
  - **#2b prompt stiffened:** the 3D section (present only when 3D was asked) now says the game MUST be Three.js and must NOT fake depth with a 2D canvas; the model catalog says NEVER invent a model name (build unknowns from primitives).
- **Result (verified):** `ensure-runtime.test.ts` F.1–F.7 (no-map→map, CDN-map replaced, idempotent, loadModel scaffolding, unknown-name fail-soft, marker-only); `game-edit.test.ts` C.1–C.5 (2D+3D→rebuild incl. Hinglish, non-3D edit stays a patch, already-3D edits normally, no-game→false); `route.test.ts` C.R (3D-on-2D ships the rebuilt 3D game, no patch/regen). Full suite **1177 pass / 1 skip**, typecheck clean.
- **Impact:** 3D requests now actually produce Three.js games, and a 3D game can never reach the preview/served file with an unresolvable `"three"` — the black-screen + infinite-repair loop is structurally gone.
- **Prevention:** **class = injected runtime scaffolding lost on a downstream re-render.** The floor is marker-independent and applied at every render/produce site, not just first delivery — the same class the earlier `/api/repair` importmap gap belongs to.
- **Related:** builds on the marker mechanism (KNOWN_BUGS #5 / 2026-07-20); the "DoubleSide" three-import lint (2026-07-20) is complementary (bad NAMED export vs unresolvable specifier). Not committed pending `/commit`.
- **Follow-up (same day, after the import-map fix): a SECOND, independent black-screen cause.** UAT still showed a black canvas (score/buttons fine). Reproduced the exact game HTML in a headless browser (playwright-core + cached chromium): `three` loaded, renderer built, first render completed, car loaded, ZERO errors — yet a screenshot was fully black, matching the owner's. **Root cause: a double `<canvas>`.** The model put `<canvas id="gameCanvas">` in the HTML AND let the renderer create its own via `container.appendChild(renderer.domElement)`; the empty leading canvas (in flow, 100% height) covered the rendered one. Confirmed VISUALLY: double-canvas → black; renderer reusing the existing canvas → the scene renders. **Fix (two levers):** (1) deterministic CSS floor in `ensureAssetRuntime` — `canvas:not(:last-of-type){display:none!important}` for 3D games, which hides only a redundant LEADING canvas and never the sole/renderer canvas (screenshot-verified it fixes the double case and leaves a correct game untouched); (2) prompt (`prompt-catalog.ts` step 3) now prescribes ONE canvas passed to `new WebGLRenderer({ canvas: … })` and forbids appending a second. Also hardened `ensureAssetRuntime` to guarantee EXACTLY ONE import map (a model-invented CDN/unpkg map alongside ours is now deduped, not left as a pair). Verified end-to-end: the owner's game run through the real preview pipeline (ensureAssetRuntime→injectPreviewRuntime→injectConsoleCapture) now renders the scene, no page errors. Tests `ensure-runtime.test.ts` F.8–F.11. **Lesson: a console-clean 3D game can still be a black screen — verify 3D fixes with a real-browser SCREENSHOT, not just console/DOM assertions** (the first probes passed on console alone and missed it).

### 2026-07-23 — REGRESSION: alert-scoping migration aborted getDb() on every existing DB (parent PIN swallowed, chat-save 500s)

- **Symptom (owner, live UAT):** after the per-account-scoping fix, the **parent area wouldn't open — the PIN was silently swallowed**; the server log also showed `no such column: accountId` on chat-save (`PUT /api/chats/[id]` → 500) and on `turn-result`/`usage` writes ("ignored").
- **Surface area:** `src/lib/db.ts` (`getDb()` schema + migration). New test: `src/lib/db.migration.test.ts`.
- **Root cause:** the scoping fix put `CREATE INDEX ... ON alerts(accountId, ...)` in the **base schema block**, which runs BEFORE the migration that adds the column. On any **pre-existing** DB, `CREATE TABLE IF NOT EXISTS alerts` is a no-op (the old table has no `accountId`), so that index build threw `no such column: accountId` — and because it's in the same `db.exec()` that seeds the whole schema, the throw **aborted `getDb()` entirely**. `db` was left half-initialised and every subsequent DB call failed: parent-PIN verification, chat history upsert, alert writes — all of them. Fresh (`:memory:`) DBs were fine because there the column exists from `CREATE TABLE`, which is exactly why the shipped tests (all `:memory:`) missed it.
- **Fix:** remove the index from the base block; create it **after** the migration ALTER, unconditionally and idempotently (`CREATE INDEX IF NOT EXISTS`). Legacy DBs get the column from the ALTER then the index; fresh DBs get the column from `CREATE TABLE` then the same index. `db.ts:38-51` (base `alerts` table, index removed) + `db.ts:207-215` (ALTER, then unconditional index with the ordering rationale in-comment).
- **Result (verified):** `db.migration.test.ts` M.1 seeds a **real on-disk legacy DB** (old `alerts` schema, no `accountId`) — RED before (`expected [Function] to not throw ... 'no such column: accountId'`), GREEN after; column + index now present, scoped record/list works, legacy NULL row still shown to no one. Full suite **1164 pass / 1 skip**, typecheck clean. **Live DB recovers on next server restart** (the migration runs on the fixed init path).
- **Impact:** the app was effectively down for any existing install (parent controls + chat persistence broken). No data loss — the failure was at read/write init, not a destructive write.
- **Prevention:** **class = migration-on-existing-DB, not just fresh-DB.** New test uses a seeded on-disk file, not `:memory:`. Rule going forward: any schema change that migrates existing rows gets at least one test that opens a DB pre-seeded with the OLD schema — `:memory:` alone cannot catch ordering bugs between the base block and the migration.
- **Related:** direct follow-up to the entry below (per-account scoping); commit `de136135` introduced it. KNOWN_BUGS: n/a (found + fixed same day).

### 2026-07-23 — PRIVACY: every parent saw every child's safety alerts (no per-account scoping)

- **Symptom (owner):** a parent opening the parent dashboard saw the block / high-risk alert history of EVERY child across ALL families, not just their own.
- **Surface area:** `src/lib/db.ts` (`alerts` table + `SqliteAlertStore`), `src/app/api/alerts/route.ts`, `src/app/api/chat/route.ts` (`alert()`), `src/app/api/safety/route.ts`, `src/lib/db.ts` (`SqliteScreenTimeStore`), `src/types/alert.types.ts`. New tests: `src/lib/db.alerts.test.ts`, updated `alerts/route.test.ts`.
- **Root cause:** the `alerts` table had **no owning-account column** — alerts were stored globally, and `SqliteAlertStore.list(limit)` returned ALL of them. `GET /api/alerts` gated on a verified parent session but then returned the global list. This was known/documented tech debt (PRD-PARENT-AUTH-ALERT-SCOPING §8 said "Phase 2 child scoping" was deferred — the route comment literally read "the list is still global — any verified parent sees all alerts"). It stayed global.
- **Fix (test-first, tenancy fail-closed):**
  - `alerts` gains an `accountId` column (+ index) with an idempotent migration for existing DBs; `ParentAlert.accountId` added to the type; `AlertStore.list(accountId, limit)`.
  - Every recorder now tags the alert with the owning account: `/api/chat`'s `alert()` uses the child's `userId` (the SSO family account `user:<email>` for a signed-in child, else the guest id); `SqliteScreenTimeStore` uses its `accountId` param; the standalone Guard-extension `/api/safety` uses a namespaced `"extension"` sentinel.
  - `SqliteAlertStore.list` filters `WHERE accountId = ?`; `/api/alerts` passes the verified parent's account.
  - **Fail closed:** a pre-migration row has `accountId = NULL`, which matches no account → legacy global alerts are shown to NO parent (they stop leaking) instead of everyone.
- **Result (verified):** `db.alerts.test.ts` — family A never sees family B's alerts, unknown/legacy accounts get nothing (RED before, GREEN after); `alerts/route.test.ts` — the route queries with the verified parent's account and returns only their own (A.3/A.3b). Full suite **1160 pass / 1 skip**, typecheck clean.
- **Impact:** closes a cross-family PII leak on a children's platform — the single most sensitive data (a child's flagged/blocked messages) is now visible only to that child's own parent.

### 2026-07-23 — Edit leaked raw SEARCH/REPLACE conflict markers into the saved game (corrupted the New Testament quiz)

- **Symptom (owner UAT):** editing a game with "remove the leaderboard" didn't work — the leaderboard word stayed, and the saved game HTML contained raw patch markers (`>>>>>>> REPLACE`, `<<<<<<< SEARCH`, `=======`) sitting inside the `<style>` block. A follow-up "the leaderboard word is still there" confirmed the edit never took.
- **Surface area:** `src/lib/repair-prompt.ts` (`applyPatch`), `src/lib/repair-prompt.test.ts`, `src/app/api/chat/route.test.ts`.
- **Root cause (proven, from the owner's actual game HTML):** on an edit turn the model wrapped a **HALF-PATCHED** document in a ` ```html ` fence — it left the SEARCH/REPLACE markers INSIDE the HTML instead of expressing a clean patch. `applyPatch`'s regeneration fallback (`const full = fenced ?? …; if (full?.trim()) return { ok:true, mode:"regeneration" }`) accepted that fenced blob **verbatim**, with no check that it was actually a clean document. So the corrupted HTML — markers and all — became the stored artifact and rendered (the markers landing in the `<style>` block as invalid CSS, the edit lost). The reversed/partial marker order (`REPLACE` before `SEARCH`, no closing `REPLACE`) means `PATCH_RE` never matched a real block, so nothing was applied.
- **Fix (test-first, red→green):** `applyPatch` now rejects a would-be full document that still carries conflict markers — `CONFLICT_MARKER_RE = /<{7} SEARCH|>{7} REPLACE/` (the 7-angle-bracket sigils never appear in a real game) → returns `{ ok:false, reason:"conflict_markers" }`. That routes through the existing failed-patch path in `api/chat/route.ts` (cheap strict rung → ONE full regeneration), so the child gets a clean rebuilt game instead of a corrupted one — never a dead end, never markers shipped.
- **Result (verified):** `repair-prompt.test.ts` — two new tests (fenced + unfenced malformed markers) were RED before the guard, GREEN after; `route.test.ts` — new end-to-end test proves a leaked-marker reply → full regeneration, `artifactHtml` contains no `>>>>>>>`/`SEARCH`. Existing patch/regeneration tests unchanged. Full suite green, typecheck clean.
- **Impact:** a whole class of "the edit didn't work and the game looks broken" — any time the model fences a partially-patched document — now fails closed to a clean regeneration instead of persisting a corrupted game. Independent of (and unrelated to) the separate "� in the preview menu" report, which is not reproducible in-house and remains open pending a live char-code diagnostic.

### 2026-07-23 — Teacher mode gets an HONEST safety-block message (the kid "tell me more" redirect didn't help an adult author)

- **Symptom (what the user saw):** when a build was provider-safety-blocked in `/bible-teacher`, Ari showed the kid copy — *"Hmm, that one tangled me up! Try telling me a bit more…"* — which is misleading for a verified-adult teacher: more context won't clear a genuine safety block, and it hides WHY it happened. Owner ask: *"in the adult mode, honest answer would help find solutions."*
- **Root cause:** the model-safety block path emitted one message (`MODEL_GLITCH_RETRY`) for everyone, regardless of persona.
- **Fix (copy only — NO safety posture change):** `src/lib/chat-copy.ts` adds `adultSafetyBlockMessage(safetyInfo)` + `blockedCategoryNames(safetyInfo)`; the block handler in `src/app/api/chat/route.ts` now branches on `persona.inputRuleMode === "adult"` → the teacher gets an honest message that names the tripped category (harassment / hate speech / …) from the provider's own ratings and gives a concrete next step (summarize tense content at a higher level, resend). Kids keep the gentle `MODEL_GLITCH_RETRY`.
- **Result (verified):** `chat-copy.test.ts` (category extraction + honest-vs-kid copy) and `route.test.ts` (a verified-adult bible-teacher SAFETY block returns the honest message, names "harassment", is NOT `MODEL_GLITCH_RETRY`). Full suite **1149 passed / 1 skipped**, typecheck clean.
- **Related:** the HARASSMENT threshold entry below (fewer blocks now, but honest copy for the ones that remain); the block-copy split (2026-07-21/22).

### 2026-07-23 — SAFETY-POSTURE CHANGE: bible-teacher HARASSMENT relaxed LOW→MEDIUM (benign faith edits still blocked with the persona ACTIVE)

- **Symptom (what the user saw):** on `/bible-teacher`, signed in and verified-adult, a plain edit — **"remove the leaderboard"** — on a *New Testament Character Quiz* got safety-blocked and Ari showed the retry copy. This was WITH the teacher persona correctly engaged, confirmed in `logs/app.log`: `input-rules action=allow persona=bible-teacher` … `⛔ model output safety-blocked [HARASSMENT:LOW, HATE_SPEECH:LOW, …]`.
- **Owner authorization:** the owner reproduced it live and asked to fix problem B; this safety-threshold change was applied with explicit owner sign-off (a safety relaxation is never made silently).
- **Root cause:** the block is on the model's OUTPUT (the edited Bible game HTML re-emitted on an edit turn), not the input. The bible-teacher persona already relaxed **HATE_SPEECH** to MEDIUM, so `HATE_SPEECH:LOW` passed — but **HARASSMENT stayed at `BLOCK_LOW_AND_ABOVE`**, so `HARASSMENT:LOW` alone tripped the block. Bible narratives are full of conflict (Goliath's taunts, persecution, "enemies of Israel"), which reads as low-confidence harassment exactly the way faith content reads as low-confidence hate speech. Class: **the faith-content latitude covered only one of the two categories benign scripture trips.**
- **Fix:** in `src/lib/persona/persona.ts`, `BIBLE_TEACHER_SAFETY` HARASSMENT `BLOCK_LOW_AND_ABOVE → BLOCK_MEDIUM_AND_ABOVE` — mirroring the HATE_SPEECH scoping. **Scope is unchanged and tight:** only the verified-adult `bible-teacher` persona; the kid `default` persona keeps HARASSMENT at the strictest LOW (pinned by `gemini.safety-config.test.ts`). SEXUALLY_EXPLICIT stays strictest; DANGEROUS_CONTENT unchanged. The OUTPUT game is still played by children under every other guard — this only changes the adult authoring turn's provider threshold.
- **Result (verified):** `persona/persona.test.ts` now pins `bible-teacher` HARASSMENT = MEDIUM and `default` HARASSMENT = LOW (split from the old "both LOW" assertion); persona + safety-config suites **19/19**. The live repro ("remove the leaderboard") is expected to pass now that neither `HARASSMENT:LOW` nor `HATE_SPEECH:LOW` exceeds the persona's MEDIUM bar — owner to re-confirm in UAT.
- **Impact:** verified-adult teachers can author/edit Bible games whose benign conflict narratives previously false-positive-blocked. No change to the kids' surface or to any other category.
- **Prevention:** thresholds live in the single `persona.ts` registry, each category pinned per-persona by test; a regression that widened this to the child default, or narrowed the faith latitude back, turns those tests red.
- **Related:** the entry below (2026-07-23 HATE_SPEECH re-scope to the persona), 2026-07-22 (original HATE_SPEECH LOW→MEDIUM), PRD-BIBLE-TEACHER §6, and the separate provider-block copy work (2026-07-21/22).

### 2026-07-23 — SAFETY-POSTURE CHANGE: child-default HATE_SPEECH re-tightened LOW (relaxation re-scoped to the bible-teacher persona)

- **Context:** the bible-teacher persona (PRD-BIBLE-TEACHER) gives verified-adult Sunday-school teachers a dedicated authoring surface. Faith games are now built through that persona, which carries the HATE_SPEECH=MEDIUM latitude added 2026-07-22 (entry below).
- **Change:** the 2026-07-22 global HATE_SPEECH `LOW→MEDIUM` relaxation is now **scoped to `bible-teacher`** only. The **child default is tightened back to the strictest `BLOCK_LOW_AND_ABOVE`** — kids no longer pay for the faith-content false-positive latitude, because that content is authored through the adult persona instead.
- **Source of truth:** safety thresholds moved into `src/lib/persona/persona.ts` (`PERSONAS.default` / `PERSONAS['bible-teacher']`), the single place a threshold is set; `GEN_CONFIG.safetySettings` reads `PERSONAS.default`.
- **Guardrails:** `persona/persona.test.ts` pins both postures; `gemini.safety-config.test.ts` updated to pin the child default (HATE_SPEECH=LOW); `gemini.persona-config.test.ts` pins that the persona sends prompt+safety together. HARASSMENT + SEXUALLY_EXPLICIT stay strictest in BOTH personas.
- **Watch at UAT:** a Bible-themed game built in the **normal child app** (not `/bible-teacher`) is again subject to the stricter HATE_SPEECH=LOW — the exact false-positive from the entry below could recur there. Expected/intended: such games belong on the teacher surface. Full suite **1124 pass / 1 skip**, typecheck clean.

### 2026-07-22 — SAFETY-POSTURE CHANGE: HATE_SPEECH relaxed LOW→MEDIUM (benign faith content was blocked)

- **Symptom (what the user saw):** a church pastor's Sunday-school Bible game ("100 New Testament names + 80 followers of Jesus, sort follower/not") was repeatedly hard-blocked by Gemini's OUTPUT safety layer (`finishReason: SAFETY`) → the "tangled up" retry, never a game.
- **Surface area:** `src/lib/gemini.ts` (`GEN_CONFIG.safetySettings`), `src/lib/gemini.safety-config.test.ts` (new).
- **Root cause (proven, not guessed):** the safety-block attribution logging shipped earlier the same day (`summarizeSafetyRatings`) named the culprit on the live block: `[HARASSMENT:NEGLIGIBLE, HATE_SPEECH:LOW, SEXUALLY_EXPLICIT:NEGLIGIBLE, DANGEROUS_CONTENT:NEGLIGIBLE]`. So the block came **solely from HATE_SPEECH at LOW confidence** — the classifier is only faintly suspicious of benign faith content (religion is a protected attribute), but HATE_SPEECH was set to `BLOCK_LOW_AND_ABOVE`, so even a LOW flag blocked. Every other category was NEGLIGIBLE.
- **Fix (owner-approved threshold change):** HATE_SPEECH `BLOCK_LOW_AND_ABOVE → BLOCK_MEDIUM_AND_ABOVE` — the same level `DANGEROUS_CONTENT` already uses. `MEDIUM+` still blocks content Gemini is moderately-or-more confident is genuine hate; a LOW-confidence flag (benign faith/cultural content) now passes. **Nothing else loosened:** HARASSMENT + SEXUALLY_EXPLICIT stay at the strictest `LOW` (the attribution showed they were NEGLIGIBLE — not the culprit), the deterministic input rules (`safety.rules.ts`) and the child-safety system prompt are unchanged, and the fail-closed behavior on a MEDIUM+ block is unchanged.
- **Result (verified):** `gemini.safety-config.test.ts` pins the posture — HATE_SPEECH=MEDIUM, HARASSMENT=LOW, SEXUALLY_EXPLICIT=LOW, DANGEROUS=MEDIUM — so it can never drift silently. RED before the change (HATE_SPEECH was LOW), green after. Full suite **1095 pass / 1 skip**, typecheck clean.
- **Impact:** legitimate faith/Bible/cultural educational content (Sunday-school games) now generates; genuine hate speech (MEDIUM+) is still blocked, and every other guard is intact. This is a documented, evidence-based loosening of ONE category by ONE step — not a blanket relaxation.
- **Prevention:** the four thresholds are now unit-pinned; any future change to the kids' safety posture fails a test unless it's deliberate. Decision made from the attribution log (real block data), not a guess.
- **Related:** the safety-block attribution logging (BUG-FIX-LOG 2026-07-22, same day — the tool that identified the category), `MODEL_GLITCH_RETRY` copy (the earlier "guide, don't loosen" step that context alone couldn't rescue for heavy generation), CLAUDE.md §3 (safety posture).

### 2026-07-22 — provider safety blocks were un-attributable: `category: null` hid WHICH filter fired

- **Symptom (what the user saw):** benign faith content kept getting "hard blocked" — a church pastor's Sunday-school Bible game ("a pool of 100 New Testament names + 80 followers of Jesus, sort follower/not") is blocked by Gemini's OUTPUT safety layer (`finishReason: SAFETY`). We could NOT tell which category (HATE_SPEECH vs HARASSMENT vs DANGEROUS) was misfiring — the parent alert logged `category: null` — so we couldn't decide which threshold to relax.
- **Surface area:** `src/lib/gemini.ts` (`summarizeSafetyRatings`, `toProviderChunks`), `src/lib/model-runner.ts` (`ProviderChunk.safetyInfo`, `SafetyBlockedError.safetyInfo`), `src/app/api/chat/route.ts` (log + alert).
- **Root cause:** the streaming core read `finishReason` but discarded Gemini's per-category `safetyRatings`, so nothing downstream knew the blocking category or confidence.
- **Fix (observability ONLY — no safety-posture change):** the Gemini adapter now normalizes `safetyRatings` into a compact string (`summarizeSafetyRatings`, e.g. `HATE_SPEECH:MEDIUM(blocked)`), carried on a SAFETY finish through `ProviderChunk.safetyInfo` → `SafetyBlockedError.safetyInfo` → the route's block log AND parent-alert reason: `⛔ model output safety-blocked [HATE_SPEECH:MEDIUM(blocked)] — redirecting`. Thresholds, fail-closed behavior, and the kid-facing copy are UNCHANGED.
- **Result (verified):** `gemini.finish-reason.test.ts` FR.6 (a SAFETY block carries the offending category+confidence) + `summarizeSafetyRatings` truth table (prefers blocked; falls back to >LOW; undefined when empty). Full suite **1091 pass / 1 skip**, typecheck clean.
- **Impact:** the next real block names its category in the log — so the pending decision (relax which category `LOW→MEDIUM`, owner call) can be made from evidence instead of a guess. No behavior change for children.
- **Prevention/next:** with a day of attribution data, decide the targeted threshold relax (the recurring faith-content false-positive). Provider-agnostic `safetyInfo` string keeps model-runner/route free of Gemini's rating shape.
- **Related:** the `MODEL_GLITCH_RETRY` copy (2026-07-21/22), the `finishReason SAFETY` fail-closed handling (2026-07-20), the deferred safety-threshold decision.

### 2026-07-22 — blank game in production: the model reported "done" on a TRUNCATED build and the pipeline shipped it

- **Symptom (what the user saw):** created a Sunday-school game ("Jesus + 30 New Testament characters, sort followers, 1-min, max 20 correct"); the published game "opened without anything" — blank. The shown code was cut off mid-CSS (no character data, no JS, no `</html>`).
- **Surface area:** `src/app/api/chat/route.ts` (the fresh-build delivery path), `src/lib/game-edit.ts` (new `looksTruncatedDocument`), `src/lib/chat-copy.ts` (`BUILD_INCOMPLETE_RETRY`), `route.test.ts`, `game-edit.test.ts`.
- **Root cause (proven from prod logs):** the same 347-char prompt ran three times → `stream done chars=4404 / 5776 / 5097`, each ending cleanly with **no** MAX_TOKENS and no error. A complete game is ~15–25K chars and the output budget is 24,576 tokens, so it wasn't a ceiling — the model **returned `finishReason: STOP` ("I'm finished") on a half-written document**, consistently, for this heavy "30 items" ask. The delivery path did `extractArtifact(full)` → `send({type:'done', artifactHtml})` with **no completeness check**, so the partial was stored and published blank. Class: **trusting the model's self-reported completion.** (The edit path already had `looksLikeCompleteDocument`; the fresh-build path never got it.)
- **Fix:** don't trust "done" — verify.
  - `looksTruncatedDocument(html)` (`game-edit.ts`): opened `<html` but no closing `</html>` — deliberately narrower than `!looksLikeCompleteDocument` so a legitimate fragment game never false-fires.
  - `completeTruncatedBuild()` — a shared guard applied to **BOTH** delivery paths: on a truncated build, **one corrective regen** demanding a COMPLETE + COMPACT document (store the 30 characters as a JS array, don't truncate). If the retry closes, ship it. If it's STILL truncated, **never publish a blank game** — send `BUILD_INCOMPLETE_RETRY` (a friendly "that got too big — try again, or ask in two steps") with **no artifact**.
  - **Both paths, not just fresh builds** (owner UAT follow-up 2026-07-22: *"a new chat developed a game but the old chat did not"*). The new chat was a fresh build (guarded from the first deploy — logs showed `⚠ build output incomplete … — corrective retry` → `✓ … produced a whole game`). The **old chat was an EDIT turn** (that chat already had a game), which routes to the edit path and its own full-regeneration fallback (`route.ts:~597`) — originally unguarded, so a truncated rebuild there still shipped. The shared helper now covers the edit-fallback too, so an old chat gets the same protection as a new one.
- **Result (verified):** `game-edit.test.ts` (looksTruncatedDocument truth table incl. fragment/empty). `route.test.ts` CG.1 (truncated build + complete retry → the WHOLE game ships, never the partial, exactly one retry), CG.2 (truncated build + still-truncated retry → NO artifact + `BUILD_INCOMPLETE_RETRY`), CG.3 (a complete build ships as-is with NO corrective retry — guard never misfires), CG.4 (an EDIT turn whose rebuild fallback is truncated never ships the partial — old-chat parity). RED before the guard, green after; full suite **1087 pass / 1 skip**, typecheck clean.
- **Impact:** a build that the model cut short is never published blank — it either gets a complete game via the compact retry, or a clear "try again / split it" message. No data-shape change.
- **Prevention:** the completeness check is now a named, unit-tested helper applied to BOTH build and edit paths; a truncated build can't silently ship. **Remaining gap:** a game that is structurally complete (`</html>` present) but renders blank from a runtime JS error — that needs real-browser paint detection (TECH_DEBT #64's harder half), not a string check.
- **Related:** platform `TECH_DEBT.md #64` ("No pre-delivery blank-game check" — build half now closed), the `finishReason SAFETY` handling (BUG-FIX-LOG 2026-07-20), `looksLikeCompleteDocument` (edit path).

### 2026-07-21 — a provider false-positive safety block told a mid-build kid to "talk about something else", same as a real content block

- **Symptom (what the user saw):** a valid game-edit request (e.g. "put the score below the car") occasionally hit the provider's own safety layer (finishReason SAFETY) and the kid got the gentle topic-change line — "Let's talk about something else!" — even though they'd done nothing wrong and were mid-build. It read as "Ari refused my game."
- **Surface area:** `src/app/api/chat/route.ts` (the `finishReason SAFETY` / `SafetyBlockedError` output-block path), `src/app/api/chat/route.test.ts`, new `src/lib/chat-copy.ts`.
- **Root cause:** a single `KIND_REDIRECT` string served BOTH block classes — a genuine INPUT block (the child typed something the rules refuse: profanity/self-harm/PII) AND a MODEL false-positive (the request was allowed, the provider glitched on generation). The topic-change copy is right for the former and wrong/confusing for the latter. Class: **one message conflating two distinct outcomes.**
- **Fix:** distinct copy per case. `MODEL_GLITCH_RETRY` is sent on the provider-safety output block; `KIND_REDIRECT` still serves genuine input blocks. Fail-closed posture is UNCHANGED — the generation is still blocked, still parent-alerted, still logged; only the kid-facing wording differs. **Both constants moved into `src/lib/chat-copy.ts`** (owner call 2026-07-21): a Next App Router route file may only export request handlers/config, so exporting them from `route.ts` for the test broke the build (`.next/types` `OmitWithTag`) — a lib module is their correct home.
  - **Follow-up 2026-07-22 — actionable hint instead of a dead "say it another way".** Root-caused the recurring false-positive: Gemini's HATE_SPEECH/HARASSMENT classifier (strictest `BLOCK_LOW_AND_ABOVE`, `gemini.ts`) fires at LOW confidence on benign FAITH content (religion is a protected attribute) — "add Jesus as JESUS", a Sunday-school Bible quiz. **Verified live on prod:** the bare prompt blocks, but the SAME prompt prefixed with "for a kids educational game" (or "this is for a church Sunday school class") GENERATES a full game — the classifier weighs context, and honest benign framing drops the score below LOW. Rejected weakening the threshold (LOW→MEDIUM) AND an auto-reframe retry; chose to **keep the strict filter** and instead make the block message GUIDE the user to supply that context: `MODEL_GLITCH_RETRY` is now "Hmm, that one tangled me up! Try telling me a bit more — what your game is about and who it's for — and I'll build it. ✨". Copy-only change; no safety-posture change.
- **Result (verified):** `route.test.ts` +2 cases — a model glitch gets `MODEL_GLITCH_RETRY` not `KIND_REDIRECT`; a hard input block still gets `KIND_REDIRECT` (and never calls Gemini). 55/55 in that file; full suite green; typecheck clean (the route-export build error is resolved by the lib move).
- **Impact:** kids no longer read a topic-change deflection after a provider hiccup on a perfectly fine game edit — they're invited to rephrase and continue. No safety-posture change (blocks still block + alert).
- **Prevention:** the two messages are now separate, named constants with tests asserting each block class maps to the correct one — the "one string, two meanings" conflation can't silently return. Shared kid-facing copy lives in `lib/`, never exported from a route file.
- **Related:** the `finishReason SAFETY` fail-closed handling (BUG-FIX-LOG 2026-07-20, "a model SAFETY block read as an outage").

### 2026-07-21 — "✨ Make my game better!" was dead while Ari was building: the button couldn't send ideas mid-generation, and there was no way to queue them

- **Symptom (what the user saw):** while a game was still generating, opening the 🎒 Idea Bag and tapping "✨ Make my game better!" did nothing useful — it closed the panel but the ideas stayed bagged and nothing went to Ari. The button read "🛠️ Still building the last one…" and was greyed out. Owner ask (three messages): the ideas "need to send to Ari and make the game better", and "I should be allowed to send ideas and it should be queued and worked upon after that response lands."
- **Surface area:** `src/components/IdeaBag.tsx`, `src/components/IdeaMicTab.tsx` (both ✨ buttons), `src/components/ArtifactFrame.tsx` (prop pass-through), `src/components/ChatPanel.container.tsx` (`handleMakeBetter`), `src/lib/idea-bag.ts` (+ `.test.ts`).
- **Root cause:** by design, `handleMakeBetter` early-returned on `if (busy) return;` and both ✨ buttons were `disabled={busy}` — so during any in-flight generation the whole make-better path was inert. Capture kept working (PRD §2), but there was no path to SEND while busy and no queue, so a kid who bagged ideas mid-build had to wait, remember, and come back. Class: **a busy-gated action that blocks instead of deferring** — the same shape as the composer being unusable mid-turn, but here with no queue behind it.
- **Fix:** send-while-busy is now a QUEUE, not a block.
  - Two pure helpers in `idea-bag.ts`: `makeBetterOnClick({busy, hasBaggedIdeas})` → `send-now | queue | ignore`, and `ideaQueueAction({queued, busy, hasBaggedIdeas})` → `send | clear | wait` (fires the queued send when `busy` flips false; self-clears if every queued idea was discarded while waiting, so it can never fire an empty bundle).
  - `ChatPanel.container.tsx`: `handleMakeBetter` now queues on busy (`queuedMakeBetter` state) and a `useEffect` flushes it via the shared `sendMakeBetter()` the moment the turn lands. Ideas still flip to `sent` only on the `done` success path — a failed/dropped queued send keeps everything bagged (unchanged contract).
  - Both ✨ buttons are always enabled; labels reflect state ("✨ Make my game better!" idle → "✨ Send these — Ari builds them next!" busy). A blue "⏳ Ari will add your ideas next!" pill by the 🎒 chip confirms a queued send so a busy tap never looks like it did nothing.
- **Result (verified):** `src/lib/idea-bag.test.ts` +7 cases (26 total) pinning both helpers' truth tables — RED before the helpers existed, green after. Full suite **1083 passed / 1 skipped**; typecheck clean for all touched files (the pre-existing `.next` `KIND_REDIRECT` error in `api/chat/route.ts` is unrelated and was already present in the tree). Visual pass at 375px on all three states (idle button / busy-queues button / queued pill).
- **Impact:** kids can send their play-time ideas to Ari WITHOUT waiting for the current build; a mid-build tap lines them up and they go automatically when the turn finishes. No data-shape change; the bag-empties-only-on-success guarantee is preserved.
- **Prevention:** the send-now-vs-queue and flush decisions are pure, unit-tested functions (`makeBetterOnClick`, `ideaQueueAction`) rather than inline `busy` checks — the class ("busy-gated action silently blocks") is now regression-locked at the logic layer, not just the button's `disabled`.
- **Related:** PRD-IDEA-BUTTON.md §2.3 + U13 (updated — U13 previously specified "✨ disabled until done"); `docs/REGRESSION-TEST-CATALOG.md` idea-bag row.

### 2026-07-20 — a model SAFETY block read as an outage: `finishReason` was never inspected, so a blocked candidate walked the whole chain and ended in a blank bubble / error

- **Symptom:** a stream that ended with no answer text was treated as an
  undifferentiated dud slot (the 2026-07-20 empty-completion fix). A Gemini
  `finishReason: SAFETY` (candidate blocked) was indistinguishable from
  `MAX_TOKENS` (thinking ate the output) — both burned a chain slot, and a
  genuine child-safety block silently walked every fallback model trying to get
  an answer, ending in an error or blank bubble instead of a safe redirect.
- **Surface area:** `src/lib/model-runner.ts` (ProviderChunk `finishReason`,
  `SafetyBlockedError`, empty-completion branch), `src/lib/gemini.ts`
  (`normalizeFinishReason`, `withReducedThinkingBudget`, `openStream` opts),
  `src/app/api/chat/route.ts` (SAFETY → blocked + alert).
- **Root cause:** nothing read `finishReason`, so the runner could not tell a
  verdict from an outage from a fixable truncation.
- **Fix:** surface a normalized `finishReason` (`safety` | `max_tokens` |
  `stop` | `other`) on every terminal chunk. The runner now branches on it when
  a stream ends empty: **SAFETY** (and PROHIBITED_CONTENT/BLOCKLIST/SPII) →
  `SafetyBlockedError`, which is TERMINAL — it never walks the chain (you don't
  route around a safety block) and propagates raw so the route sends the kind
  redirect + logs a model-origin parent alert (fail closed). **MAX_TOKENS** →
  reopen the SAME model once with a halved thinking budget (KNOWN_BUGS #4's
  "smaller budget would fix it"), then walk if it's still empty. Everything else
  walks unchanged.
- **Result (verified):** `gemini.finish-reason.test.ts` FR.1–FR.5 (SAFETY and
  a sibling reason fail closed with NO second model tried; MAX_TOKENS retries
  the same model at a lower budget and its answer wins; the retry happens at
  most once then walks; unrelated empties still walk). `route.test.ts` proves a
  SAFETY-blocked stream emits `blocked` (kind redirect), never `error`/`done`.
  The load-bearing `gemini.fallback.test.ts` F.1–F.7 and
  `model-runner.oneshot.test.ts` B.1–B.7 pass UNTOUCHED. Full suite green (1000).
- **Impact:** a blocked candidate is now a safe, honest redirect instead of a
  fake outage; a truncated build gets one cheaper retry before degrading.
  **Safety posture strengthened** — the chain can no longer try to bypass a
  provider safety verdict.
- **Prevention:** FR.1/FR.2 pin "no chain walk on SAFETY"; the F/B suites guard
  the default paths. **Class: safety verdict must fail closed, not fall back.**
- **Related:** the empty-completion fix (entry below), KNOWN_BUGS #4.
- **Residual:** the MAX_TOKENS reduced-budget heuristic (halve) is unproven
  against real traffic — MAX_TOKENS was invisible before this — so the log line
  it emits is the signal to tune it once it actually fires.

### 2026-07-20 — `inSource=false`: asset injection strips `<!--USES_MODELS-->` markers from stored games, but the model re-emits them in SEARCH, so every 3D/asset edit patch missed

- **Symptom (what prod logs showed):** on edit turns for 3D/asset games,
  `patch failed (search_not_found)` with
  `first SEARCH head: "<!--USES_MODELS: car, finish_line, tree, checkered_flag-->" inSource=false`,
  every time — escalating to a full, expensive regeneration (the trigger behind
  the 225s incidents in the entry below).
- **Surface area:** `src/lib/assets/inject.ts` (line 236, marker strip),
  `src/lib/assets/markers.ts` (new), `src/lib/game-edit.ts`
  (`reconcileAssetMarkers`), `src/app/api/chat/route.ts` (edit branch).
- **Root cause (confirmed from code, not a guess):** `injectAssets` REMOVES the
  `<!--USES_MODELS: …-->` / `<!--USES_THREE-->` / `<!--USES_AUDIO: …-->` markers
  from the delivered game — they resolve into an import map + `AR_ASSETS` table.
  So the game STORED in history (and re-shown to the model on the next edit) has
  no markers. But the 3D/asset prompt sections tell the model to always emit
  those markers, so it re-writes `<!--USES_MODELS: …-->` into its SEARCH block.
  That SEARCH text is by construction absent from the marker-stripped source, so
  `applyPatch` can never match it. **The two prior hypotheses in KNOWN_BUGS #5
  (history-trim dropping the current game; `source=newest` racing a pin) were
  wrong** — the divergence is injection mutating the stored source, not history.
- **Fix:** a new pure `markers.ts` (the marker tokens, now the single source of
  truth, shared with `inject.ts`). On a `search_not_found` patch failure the
  route calls `reconcileAssetMarkers(currentHtml, reply)`: it strips the markers
  out of the reply — byte-for-byte the way injection stripped them from the
  source — and re-applies. Guarded so it can only ever turn a FAILED patch into a
  working one: it bails unless the game was actually injected AND every asset the
  markers name is already in the game's `AR_ASSETS` (a marker naming a NEW asset
  is a real add that still takes the regeneration path). Injection stays
  idempotent because the reconciled patch output has no markers either.
- **Result (verified):** `game-edit.reconcile.test.ts` A.1–A.7 reproduce the
  production shape — a direct patch fails `search_not_found`, reconciliation
  makes it apply cleanly without regenerating — and pin the guards (new asset →
  null, plain 2D → null, genuinely-absent SEARCH still fails honestly).
  `markers.test.ts` M.1–M.9 pin marker-strip byte-parity with `injectAssets`.
  Full suite green; typecheck clean.
- **Impact:** the common asset-game edit ("make the car faster") now patches in
  place instead of triggering a whole-game rebuild — cheaper, faster, and it
  stops silently regressing parts the child liked. New-asset edits are unchanged.
- **Prevention:** the byte-parity test (M.2) ties `stripAssetMarkers` to
  `injectAssets`, so a future change to how injection removes markers can't
  silently desync the reconciliation. **Class: stored-vs-seen source divergence.**
- **Related:** the 225s timeout entry below (this is its upstream trigger, P3 in
  `PRD-RESILIENT-GENERATION.md`); KNOWN_BUGS #5; the 2026-07-18 history-trim
  `search_not_found` fix (same *symptom*, different mechanism).
- **Residual (needs prod signal):** a SEARCH block that also spans the injected
  `<head>` region (import map / AR_ASSETS scripts the model never wrote) won't
  match on marker-strip alone. The new `afterMarkerStrip=` debug flag on the
  miss line tells us, from the log, whether each remaining miss is the marker
  mechanism (rescuable) or something else. Kept open in KNOWN_BUGS #5 until a
  prod streak confirms the marker fix cleared the bulk.

### 2026-07-20 — 225 seconds, then nothing: the one-shot deadline (30s) was SHORTER than the work it wrapped, so every model in the chain timed out identically

- **Symptom (what the user reported):** "there are many incidents it went four
  fallback and returned nothing." Confirmed from prod pm2 logs (kidgemini-error).
- **The log that cracked it:**
  ```
  [api/chat] patch failed (search_not_found) — falling back to full regeneration @43953ms
  [retry] gemini.chat attempt 1 failed; retrying in 400ms
  [retry] gemini.chat attempt 2 failed; retrying in 800ms
  [gemini] overloaded — falling back to gemini-2.5-flash (gemini.chat)
  [gemini] overloaded — falling back to gemini-3.5-flash (gemini.chat)
  [gemini] overloaded — falling back to gemini-2.5-flash-lite (gemini.chat)
  [api/chat] ✖ fallback regeneration failed @225170ms: chat generation failed:
            gemini.chat timed out after 30000ms (deadline)
  ```
- **Root cause — NOT capacity, despite what the log said.** Every failure was
  OUR OWN 30s deadline. A patch-fallback regeneration is a full game build
  (thinking on, `maxOutputTokens` 24576), and the same repo's successful
  STREAMS finished at 31166ms and 46371ms — both past 30s. So `reply()` could
  never finish inside `CHAT_TIMEOUT_MS`, on any model, ever. This was
  deterministic, not intermittent, which is why it happened "many" times.
  Streaming was immune because `replyStream` has **no wall-clock cap at all**:
  its watchdog is a per-chunk stall timer that resets on every chunk, so a 46s
  stream is fine. The asymmetry was invisible because both paths share a chain.
  Arithmetic check: primary 3 attempts × 30s (the retry layer treats a deadline
  as retryable) + 3 fallbacks × 30s + the 44s patch attempt = **224s predicted
  vs 225.170s observed.**
- **Two amplifiers made it much worse than one timeout:**
  1. `isRetryable` matched the substring "deadline", so our own timeout was
     RETRIED twice against the identical budget — 90s on the primary alone,
     guaranteed to expire all three times.
  2. The chain's fallback log printed `"overloaded"` for every non-404 failure,
     so a self-inflicted timeout was reported as a Google capacity incident.
     That single wrong word pointed the investigation at the wrong system.
- **Fix:**
  - `oneShotTimeoutMs()` in `gemini.ts` — a game-BUILD one-shot now gets
    `BUILD_TIMEOUT_MS` (120s, `GEMINI_BUILD_TIMEOUT_MS`-overridable), sized off
    the 31–46s measured builds. Ordinary chat keeps 30s so no child waits two
    minutes for a sentence.
  - `TimeoutError` in `retry.ts` — a typed error so `isRetryable` can refuse
    OUR deadline (deterministic) while still retrying an upstream
    DEADLINE_EXCEEDED (may be transient).
  - `reasonFor()` in `model-runner.ts` — the fallback log now names the real
    cause: "OUR deadline expired (raise the timeout, not the chain)",
    "returned nothing", "went silent", "model gone", or "overloaded".
- **Regression tests:** `retry.test.ts` T.1–T.7 (new file; T.4 pins one attempt
  instead of three), `gemini.fallback.test.ts` F.17–F.19 (build deadline
  exceeds the slowest observed build; chat keeps 30s; env-tunable with garbage
  falling back to the default rather than disabling the timeout).
- **Correction to an earlier diagnosis today:** the empty-completion bug fixed
  in the entry below is real and separately proven, but it is NOT what caused
  these incidents. The logs show timeouts, not empty completions. Both are now
  fixed; only this one explains the 225s turns.
- **Still open:** the *trigger* is unfixed — `patch failed (search_not_found)`
  with `inSource=false` means the model patched against a different version
  than we hold (the 2026-07-18 history-trim class). Every one of these
  incidents began there; the expensive regeneration is only the fallback. See
  `KNOWN_BUGS.md`.

### 2026-07-20 — "Walked four fallbacks and returned nothing": a clean-but-empty stream was counted as SUCCESS, so the chain stopped dead and the child got a blank bubble

- **Symptom (what the user reported):** "there are many incidents it went four
  fallback and returned nothing." Repeated turns where the logs showed the
  model-fallback chain walking, and the child ended up with nothing usable.
- **Root cause:** the chain runner treated *any* clean stream end as a served
  answer. A provider can finish a stream with no answer text at all — Gemini
  `finishReason: MAX_TOKENS` (a builder turn whose thinking budget consumed the
  whole output allowance), `finishReason: SAFETY` (candidate blocked), or an
  empty candidate list. **Nothing in the codebase reads `finishReason`**
  (verified by grep across `src/lib` and `src/app/api`), so that arrived as a
  plain `done`. The runner returned having emitted zero deltas and — the real
  damage — **never tried the next model**, because it had not seen an error.
  The fallback chain's entire purpose was defeated at whichever slot came back
  empty. When earlier slots had genuinely failed first, the logs showed a full
  fallback walk ending in silence, which is exactly the reported shape.
  Thought summaries made it worse: a model that emitted only planning lines and
  then stopped also counted as "served".
- **Fix:** `EmptyCompletionError` in `src/lib/model-runner.ts`. A stream that
  ends without answer text is now modelled as a failed slot and walks the chain
  like any other dud. It bypasses the per-provider error classifier (it is our
  marker, not a provider error) alongside `StallSwitchError`. Thought summaries
  explicitly do NOT count as output. If EVERY model comes back empty the turn
  now throws, so the route shows "let's try again" instead of an empty bubble —
  an honest error beats silence the child cannot act on.
- **Regression tests:** `gemini.fallback.test.ts` F.14 (empty completion walks
  the chain), F.15 (thoughts alone are not an answer), F.16 (all-empty fails
  loudly and every slot is tried). All three fail before the fix.
- **Impact / blast radius:** every streamed chat and game-build turn, on both
  providers — OpenAI can likewise return a completion with empty content. This
  defect predates the 2026-07-20 cross-provider refactor; the runner extraction
  faithfully preserved it, and writing the failing test is what exposed it.
- **Still open:** `finishReason` is *still* never inspected, so we cannot yet
  distinguish "blocked by safety" from "ran out of output tokens" in logs —
  they look identical. Reading it would let a MAX_TOKENS slot retry with a
  smaller thinking budget instead of burning a whole chain slot. Tracked in
  `docs/KNOWN_BUGS.md`.

### 2026-07-20 — No way to copy an error when a game breaks: the debug-gating of the console left grown-ups blind too

- **Symptom (what the user reported):** "when something unexpected happens,
  earlier I used to have a console to copy the error, now it is removed."
  Confirmed: the self-healing preview work hid the console tab behind
  `localStorage["kidgemini:debug"]="1"` (PRD G1 — a nine-year-old must never
  meet a stack trace), which also removed the ONLY way an adult could copy a
  failure out of the app. Diagnosing the "DoubleSide" bug below needed the
  owner to export the game html and me to run it in a browser by hand —
  exactly the friction this closes.
- **Surface area:** `src/components/ArtifactFrame.tsx` (console tab gate,
  §9.1 failure banner), new `src/lib/error-report.ts`.
- **Root cause:** the kid-safety fix used a single global switch (debug on/
  off) where the real requirement has two axes: *who* is looking and
  *whether anything actually broke*. Hiding on both axes at once made real
  failures undiagnosable in-product.
- **Fix:** details are gated on the FAILURE, not on a debug flag.
  `hasExtremeError({outcome, errors})` (pure) is true only when the game
  threw a hard error or verify ended failed/bailed; then (a) the §9.1
  banner gains a **📋 Copy error details** button that puts a formatted
  report on the clipboard in one tap — no stack trace rendered to the kid —
  and (b) the 🛠 Console tab becomes reachable (still hidden on every
  healthy game, so PRD G1's "a kid never meets a console" holds for normal
  play). `buildErrorReport` (pure) formats title, verify verdict, numbered
  errors with stacks + resource URLs, and the browser string; bounded to
  4 000 chars so an error flood stays pasteable, and deliberately EXCLUDES
  the game source (reports get pasted into chats/tickets). Clipboard
  failure (permissions/older browser) falls back to opening the console tab
  so the text is selectable — never a dead end.
- **Result (verified):** 8 `error-report.test.ts` cases (gate truth table
  incl. log/warn noise not counting, formatting, 404 URLs, no-errors
  wording, bounded output, no source leak); real-browser run of a
  deliberately broken game with `/api/repair` forced to 502: banner shown,
  Copy button offered, Console tab back with its error badge, and the
  clipboard verified to contain the real report (both the thrown TypeError
  and the module-resolution failure). Suite 894/894, typecheck clean.
- **Impact:** any adult can hand over a complete diagnosis in one tap;
  healthy games are visually unchanged for kids.
- **Prevention (class):** "kid-safe" must mean *contextual* hiding, not
  global removal — pinned by the gate tests (a healthy game must never
  offer the affordance; a failed one always must).
- **Related:** PRD G1 (console hidden from kids); the "DoubleSide" entry
  below, whose diagnosis this would have shortened to one paste.

### 2026-07-20 — "DoubleSide": a marker-less 3D game iterated with the 3D catalog OFF — the model imported outside the curated three bundle and killed the game on its import line

- **Symptom (what the user saw):** the racing game stayed dead ("Waiting for
  the host to start…", no canvas, dead buttons) through days of edits and
  repairs, even after the preview SDK stub shipped. Running the actual game
  html (owner-provided file) in a sandboxed iframe surfaced the real error:
  `The requested module 'three' does not provide an export named
  'DoubleSide'` — the game's entire module dies on
  `import { Shape, ShapeGeometry, DoubleSide } from "three"`, so no game
  code ever runs (broken in preview AND published alike).
- **Surface area:** `src/lib/assets/catalog-gate.ts` (`THREE_ARTIFACT`,
  `AUDIO_ARTIFACT`); root contract between `scripts/vendor-three.mjs`
  (curated `THREE_EXPORTS`) and the prompt catalog.
- **Root cause (chain):** (1) the game html carried `USES_MULTIPLAYER` but
  NOT `USES_THREE`/`USES_MODELS` — the model forgot the markers; (2) the
  catalog gate's iteration insurance matched markers ONLY, so every edit
  turn ran `3d=false` (visible in the prod log) — the model edited a
  three.js game without the "only import these names" vocabulary; (3)
  untaught, it imported `Shape`/`ShapeGeometry`/`DoubleSide` — standard
  three exports absent from the tree-shaken bundle; (4) the import throws,
  classified `load_error`, and repair ping-ponged forever (an import-
  vocabulary violation is not patchable within the vocabulary). Class:
  **opt-in markers as the only carrier of a structural fact** — one
  forgotten comment silently degraded every subsequent turn.
- **Fix:** the gate now also reads the game's STRUCTURE: `THREE_ARTIFACT`
  additionally matches `from "three"`, the importmap `"three":` entry, or a
  `loadModel(` call; `AUDIO_ARTIFACT` additionally matches `playSound(` /
  `playMusic(`. A marker-less 3D/audio game keeps its catalogs on every
  iteration (err-toward-unlocking, §9).
- **Result (verified):** 3 new `catalog-gate.test.ts` cases (marker-less
  three-importing game, marker-less loadModel game, marker-less
  playSound/playMusic game — all keep their catalogs); suite 875/875,
  typecheck clean. The owner's actual game html matches the new
  THREE_ARTIFACT on both signals (import + importmap).
- **Impact:** edit turns on 3D/audio games always carry the curated
  vocabulary, ending this class of self-inflicted import crashes. The
  stuck game itself needs one edit (drop the bad import, rebuild the track
  with RingGeometry, re-add markers) — done via chat.
- **Prevention (class):** structural detection over marker trust (pinned by
  the new tests) — PLUS both follow-ups, built same day:
  (a) **deterministic import lint** (`src/lib/assets/three-import-lint.ts`,
  checked against the SAME `CURATED_IMPORT_NAMES` the prompt teaches): an
  edit patch that INTRODUCES an unknown three import is a FAILED patch
  (takes the existing fallback-regeneration path; reason
  `bad_three_imports:*` in the log), and a fresh build with one gets ONE
  corrective retry naming the exact violation — retry-fails ⇒ the original
  is still served (visible + repairable beats dropped). Route tests
  L.1–L.4; lint truth table in `three-import-lint.test.ts` (aliases,
  multiline, namespace imports exempt, introduced-vs-preexisting).
  (b) **vocabulary grown**: `Shape`, `ShapeGeometry`, `DoubleSide` added to
  `THREE_EXPORTS` (vendor-three.mjs) + `CURATED_IMPORT_NAMES`
  (prompt-catalog.ts, now the exported single source the lint shares);
  new bundle `three.97d632.js` (618 KB, budget 650 KB) built → uploaded →
  CDN-verified → manifest entry written, contract tests green. Cost: +24 KB
  on the immutable engine bundle, ~10 extra prompt tokens on 3D turns, and
  one corrective generation ONLY when a violation is caught.
- **Related:** same-day preview-SDK-stub entry (the crash this one hid
  behind); PRD-3D-GAMES-AND-ASSETS §9; `scripts/vendor-three.mjs` comment
  ("Add a name here AND to the prompt together").

### 2026-07-20 — Multiplayer games could NEVER load in the preview: the prompt promises an SDK the preview didn't provide

- **Symptom (what the user saw):** owner UAT, days of struggle on one game —
  "repair done but game is still not loading", and "every code change goes
  into 'something is wrong, fixing it'… very often 3 times or more." Prod
  log: repeated `[api/repair] ▶ code=load_error` on the same game, patches
  ping-ponging between two versions (23949 ↔ 23957 chars), plus a stack of
  `✖ patch not applicable` failures.
- **Surface area:** `src/components/ArtifactFrame.tsx` (preview srcDoc),
  new `src/lib/preview-sdk-stub.ts`; contract in
  `src/lib/multiplayer-prompt.ts` rule 9.
- **Root cause:** rule 9 of the multiplayer prompt tells the model "the
  `Ariantra` SDK always exists — in the preview and on the published page
  alike. NEVER write a polyfill, stub, or fallback… use the calls directly,
  unconditionally." The platform keeps that promise on published/invite
  pages by loading the real SDK before game code. Ari's sandboxed preview
  iframe was the one surface that DIDN'T — `Ariantra` was undefined, so
  every rule-following multiplayer game threw `ReferenceError` at load.
  Verify classified it `load_error` (a real crash — correctly repairable),
  repair "fixed" a correct game (any true fix would violate rule 9, so
  patches guessed and ping-ponged), and every subsequent edit re-entered the
  same doom loop. Class: **a cross-surface contract promised in a prompt but
  implemented on only one of the two surfaces.**
- **Fix:** `injectPreviewSdkStub()` — a preview-ONLY stub simulating a SOLO
  SESSION (owner decision 2026-07-20 after "waiting for host" UAT: a
  waiting screen that can never end reads as "still broken"): the kid is
  player 1 and host (`myPlayerId()` → "preview-solo"; `onPlayers` fires
  once, async, with `[{playerId, isHost: true, joinedAt: 0, displayName:
  "You"}]`), so roster-gated games START and every change is instantly
  playable alone. Peer-facing calls stay inert (broadcasts no-ops,
  `getPeerState` null, `onMessage` never fires). Injected into the srcDoc
  chain in `ArtifactFrame` ahead of game code, only when the html references
  `Ariantra` (single-player passes byte-identical), only-if-undefined so it
  can never shadow a real SDK, idempotent via marker. Publish/Invite still
  send `state.currentHtml` untouched — the platform's real SDK owns those.
- **Result (verified):** `preview-sdk-stub.test.ts` (6 tests — the crash
  reproduced sans stub, loads with it, solo-session semantics, never
  overwrites a real SDK, injection order/idempotency, single-player
  byte-identical); real-browser check: a rule-9, roster-gated multiplayer
  game uncovers in the preview with NO "Oops — fixing it", no give-up
  banner, 🎮 Invite intact, and its waiting screen replaced by the started
  game ("GO, You!"). Suite 872/872, typecheck clean.
- **Impact:** multiplayer games load AND start solo in the preview; the
  per-edit repair spam and its Gemini spend stop; kids stop "fixing" games
  that were never broken. Trade-off (documented): solo preview can't show
  true peer behavior — that stays on 🎮 Invite / Publish where the real
  SDK + lobby run.
- **Prevention (class):** any capability the build prompt promises the game
  must exist on EVERY surface the game renders on — the stub's tests pin the
  preview side of rule 9; `multiplayer-prompt.test.ts` pins the prompt side.
- **Related:** same-day repair-loop entries below (ghost-click, false
  repair) — this was the third and biggest contributor to the "endless
  fixing" UAT reports; PRD-MULTIPLAYER.md Phase 4.

### 2026-07-20 — "Laptop told to fix Siri": mic-blocked errors were device-blind and step-less, so a family switched devices

- **Symptom (what the user saw):** owner UAT — on a **laptop**, tapping the
  mic said "Your phone's dictation is switched off — ask a grown-up to
  enable Siri & Dictation in Settings." Wrong device, a setting that doesn't
  exist there, no steps that could work — the family changed devices to get
  voice at all.
- **Surface area:** `src/lib/mic-errors.ts` (`micErrorMessage`), reaching
  both mic surfaces (`Composer.tsx`, `IdeaMicTab.tsx`) via
  `useSpeechInput.ts`.
- **Root cause:** the mic goes through TWO doors — the site's browser
  permission (error `not-allowed`) and the OS's permission for the browser
  app itself (typically `service-not-allowed`; on a laptop that's macOS
  Privacy & Security / Windows Privacy blocking Chrome). `micErrorMessage`
  collapsed each error code to ONE hardcoded string; `service-not-allowed`'s
  string assumed iOS. Class: **one-size-fits-all copy for a
  platform-dependent fix** — and a dead end (no action, no retry, no typed
  fallback).
- **Fix:** device-aware recovery cards. Types first
  (`src/types/mic.types.ts`); `src/lib/platform.ts` (pure detection:
  platform incl. iPad-as-Mac touch check, browser, plus guarded
  `permissions.query` reader); `src/lib/mic-recovery.ts` (pure: error code ×
  platform × browser × permission state → card with numbered steps and
  who-fixes); `MicRecoveryCard.tsx` (shared presentational card: 👋
  grown-up chip on OS-level fixes, **Try again** re-checks + restarts,
  **I'll type instead** where a composer is visible). `useSpeechInput`
  queries the permission state on fatal errors and intercepts the FIRST mic
  tap at state `prompt` with a pre-ask coach card so the browser's dialog is
  expected, not dismissed. `micErrorMessage` deleted — nothing can fall back
  to the device-blind string.
- **Result (verified):** 20 new unit tests (`platform.test.ts`,
  `mic-recovery.test.ts` — S1–S10 matrix; the incident pinned: a Mac/Windows
  `service-not-allowed` card names System Settings / the desktop-apps
  toggle and NEVER matches /siri/ or /\bphone\b/); mic e2e extended from 17
  to 28 checks (site-blocked card + Try again restart, os-blocked laptop
  card + grown-up chip, pre-ask coach gating the first session); suite
  866/866, typecheck clean; visual pass at 375px and desktop.
- **Impact:** blocked-mic kids now get steps that exist on their actual
  device, a grown-up handoff signal, and always an exit (retry / type).
  Hook API change: `useSpeechInput().error` is now a `MicRecoveryCard`
  object, not a string.
- **Prevention (class):** device-dependent copy must be derived from
  detected signals, never hardcoded — enforced by the matrix tests; any new
  error code falls back to a retry card, never a blank or a wrong-device
  guess.
- **Related:** 2026-07-07 (mic errors swallowed — this surface's copy was
  born there); PRD §5a; design wireframes artifact (2026-07-20).

### 2026-07-20 — Take 2: repair falsely fired on a demonstrably-running game ("Oops — fixing it" on a healthy game, then the give-up banner)

- **Symptom (what the user saw):** owner UAT on prod, after the ghost-click
  fix below: still "a non playable game after fixing the issue," and — the
  decisive detail — the 🔧 "Oops — fixing it" line, then Ari's give-up
  question ("Hmm, that one didn't come out right…"), on games whose stored
  HTML was fine (reopening the panel always worked).
- **Surface area:** `src/lib/preview-verify.ts` (classification order),
  `src/lib/verify-policy.ts` (`shouldRepair`),
  `src/lib/preview-verify-controller.ts` (`settle`).
- **Root cause:** `classifyVerify` checks captured errors BEFORE the probe
  evidence — any unhandled rejection at load classifies `async_loop`, which
  is in `REPAIRABLE_CODES`. A benign rejection on a healthy game (archetype:
  audio autoplay — `play()` rejects `NotAllowedError` without a user
  gesture, guaranteed in the sandboxed preview iframe; and the probe's own
  ghost `.click()` on Start carries no user activation either, so even
  gesture-gated audio rejects) condemned a game the probes had WATCHED
  running and drawing. Repair then rewrote healthy HTML; the (drifted or
  identical-still-"failing") patch failed the next round the same way, both
  attempts burned, and `finish` uncovered a stale/mangled live document
  while the conversation kept the good copy — the exact "broken until
  reopened" symptom. Same class as the 2026-07-10 false-repair UAT
  ("repaired" a game that ran perfectly): probe-inference codes were made
  telemetry-only then, but error-driven codes kept unconditional priority
  over evidence of health.
- **Fix:** new pure helper `demonstrablyRunning(evidence)`
  (`preview-verify.ts`): loop ticking AND pixels changing (or no canvas to
  judge — DOM games; static/tainted/zero-size are NOT proof).
  `shouldRepair` (`verify-policy.ts`) takes it as an input and refuses to
  spend a Gemini call on a demonstrably-running game regardless of the
  failure code; the controller passes it from the round's evidence. Absence
  of proof never *causes* a repair — the gate only ever withholds one, so
  genuinely broken games (no loop, static screen, crashed before reporting)
  repair exactly as before. Telemetry keeps the raw failure code either way.
- **Result (verified):** new `verify-policy.test.ts` case (every repairable
  code refused when demonstrablyRunning) and `preview-verify-controller.test.ts`
  case (running game + autoplay-style rejection → 0 repair calls, no
  "repairing" phase, no question, html untouched) both FAILED pre-fix;
  5 new `preview-verify.test.ts` cases pin the helper's truth table.
  Suite 849/849, typecheck clean, `scripts/e2e-preview-pane.mjs` 10/10.
- **Impact:** kids' games with sound (or any benign load-time rejection) no
  longer get falsely "repaired" into a broken live preview; repair spend
  drops. Games that error AND show no sign of life still self-heal.
- **Prevention (class):** "never repair what you watched work" is now a
  policy input, not an ordering accident — any future failure code added to
  `REPAIRABLE_CODES` is automatically subject to the same health gate.
  Registered in `docs/REGRESSION-TEST-CATALOG.md`.
- **Related:** entry below (ghost-click uncover — the other half of this
  UAT report); 2026-07-10 (false repair → REPAIRABLE_CODES restriction).

### 2026-07-20 — Preview sometimes uncovers a non-playable game after an update; closing and reopening the panel "fixes" it

- **Symptom (what the user saw):** owner UAT — "some time the preview pane
  shows a non playable game after fixing the issue but if i close the preview
  pane and reopen the game, it works." The game HTML itself was fine (a fresh
  mount rendered it playable); the live iframe was the broken part.
- **Surface area:** `src/lib/preview-verify-controller.ts` (`finish`),
  `src/lib/preview-verify.ts` (probe script), reaches the kid via
  `usePreviewVerify.ts` → `ArtifactFrame.tsx` (`docKey`-keyed iframe).
- **Root cause:** the self-healing verify probe **ghost-clicks the game's
  Start button** (`startProbe`, §6.2) while the game runs headless behind the
  opaque cover. The pristine-reload decision (`round` bump → new `docKey` →
  fresh iframe document, probes off) only consulted the click on the CLEAN
  finish path — and only via `evidence.start.found`. Three finish paths
  dropped the click and uncovered the already-started document: (1) a
  telemetry-only pass-through code (`canvas_static`/`start_no_loop` — probe
  clicked Start, game's first frame was slower than the 800 ms pixel window);
  (2) the ROUND_HARD_TIMEOUT settle where the result evidence never arrived
  (`evidence` null, so `Boolean(evidence?.start?.found)` read false even
  though a click happened); (3) a failed/exhausted repair whose best version
  equals the current html. In all three the kid uncovered a game that had
  been silently started ~2–4 s earlier — mid-play or already at game-over,
  with no start screen: "non-playable." Close/reopen remounts the frame →
  fresh generation → fresh document → works, which is exactly the reported
  workaround. Intermittent because it needs the probe to have found a Start
  control AND one of those three exits. Class: **decision made from a
  call-site guess instead of the round's own recorded facts** (cousin of the
  2026-07-11 "round alone is not an identity" entry — the preview iframe's
  document state must be derived from what actually happened to it).
- **Fix:** the probe script posts a dedicated `{type:"clicked"}` event the
  instant it dispatches the click (BEFORE `btn.click()`, so a lost result
  can't hide it — `buildVerifyScript`); `VerifyScriptEvent` gains the
  variant (`preview-verify.types.ts`); the controller latches `probeClicked`
  per round (reset in `beginRound`, set in `handleMessage`) and `finish()`
  now computes the reload from `latch || evidence.start.found` itself — the
  call-site parameter is gone, so no finish path can forget the click.
- **Result (verified):** 3 new `preview-verify-controller.test.ts` cases
  (canvas_static pass-through after click, hard-timeout with lost result
  after the clicked event, failed repair with best === current) all FAILED
  pre-fix and pass post-fix; 2 new `preview-verify.test.ts` cases pin the
  clicked event's existence/ordering and its absence for never-clicked
  games; existing "clean with no probe click does NOT reload (no flash)"
  still green. File 40/40, suite 842/842, typecheck clean.
- **Impact:** every verify exit now hands the kid a pristine, un-ghost-clicked
  document. No API change; one extra postMessage per probed round.
- **Prevention (class):** "the iframe's reload decision comes from the
  round's recorded facts, not call-site guesses" — `finish()` no longer
  accepts a `probeClicked` argument at all, so a future finish path cannot
  opt out. Registered in `docs/REGRESSION-TEST-CATALOG.md` (preview-pane
  section).
- **Related:** 2026-07-11 (round-collision — stale preview identity class);
  PRD-SELF-HEALING-PREVIEW §6.2/§8.4.

### 2026-07-19 — Repeat-mic, take 4: Android re-appends the same final — "every 3 words captured 30-40 times" on phone/tablet

- **Symptom (what the user saw):** owner UAT on a Pixel, in Chrome AND Edge
  (both Chromium): every ~3 spoken words arrived in the composer 30-40+
  times. Desktop was fine (takes 1-3 all still pinned green).
- **Surface area:** `src/lib/speech-transcript.ts` (`splitSpeechResults`);
  behavior change reaches both mic surfaces via `useSpeechInput.ts`.
- **Root cause:** Android Chromium's recognizer in continuous mode
  re-finalizes the SAME utterance as new results-list entries, in TWO shapes
  (both observed live): (1) re-appended verbatim — `[A]`, `[A,A]`,
  `[A,A,A]`…; (2) re-finalized as it GROWS — `["I"]`, `["I","I want"]`,
  `["I","I want","I want to"]`… (production screenshot: "I I want I want to
  I want to create…"). Each new entry sits past the committed-finals
  counter, so it arrives as a fresh ONE-segment slice — and the take-3
  replay guard deliberately lets single matches through
  (`MIN_REPLAY_RUN = 2`, the a-kid-may-repeat-a-phrase allowance); the
  grown snapshots aren't even text-equal, so no guard could match them. One
  extra commit per event × dozens of events = the 30-40x flood. Same class
  as 2026-07-14/16/18: trusting positional accounting over content identity
  across a browser stream.
- **Fix:** `effectiveFreshFinals()` in `splitSpeechResults` — within ONE
  session's list, a final identical to its predecessor is dropped (shape 1;
  "go go" arrives as one final, not two), and a final that extends its
  predecessor at a word boundary commits only the NEW words, the delta
  (shape 2: "I" → "I want" commits just "want"). Applied before the take-3
  guard, positionally aligned so the predecessor check works across the
  committed/fresh boundary. The take-3 allowance survives: a genuine repeat
  across a silence restart is the FIRST final of a fresh list (no
  predecessor) and still commits — pinned by test. Non-boundary prefixes
  ("I want" vs "I wanted…") are NOT treated as growth — pinned by test.
- **Result (verified):** 8 new `speech-transcript.test.ts` cases (the
  growing-duplicate sequence, the one-event pair, the cumulative-snapshot
  sequence and the same-event grown snapshot all FAILED pre-fix,
  reproducing both flood shapes; fresh-session repeat, distinct finals,
  word-boundary prefix and positional finalCount pin the non-regression);
  file 29/29, suite 837/837, typecheck clean.
  `scripts/e2e-mic-dictation.mjs` extended with checks 7b (verbatim
  duplicates never re-commit), 7c (real repeat still commits) and 7d
  (grown snapshots commit only their delta) — 17/17 against the running app.
- **Impact:** phone/tablet dictation commits each spoken word once. No API
  change. Remaining documented trade-off: a kid saying the exact same phrase
  twice WITHIN one unbroken session (no silence gap) is deduped, and a
  same-session second utterance that happens to extend the previous one
  word-for-word commits only its new words; across a pause both commit in
  full.
- **Prevention (class):** "identity must come from content, not position" now
  enforced at the source list itself, not only across sessions. Any future
  consumer of SpeechRecognition results must go through `splitSpeechResults`.
- **Related:** 2026-07-14 repeat-mic, 2026-07-16 take 2, 2026-07-18 take 3 —
  same class, all four now pinned in unit tests + the mic e2e.

### 2026-07-18 — Publishing to the Arcade never told the platform the game is multiplayer — no 🎮 lobby on the live page

- **Symptom (what the user saw):** owner UAT — "when i push to arcade there
  is no way to start the multiplayer game." The published game had no 🎮
  Play-together button at all.
- **Surface area:** `src/app/api/arcade/publish/route.ts` (Ari's publish
  bridge to the platform's `/api/studio/partner/publish`).
- **Root cause:** the platform injects its lobby overlay only when
  `seo.multiplayer` is true at publish time — and Ari's arcade publish never
  sent any `seo` at all, so every kid-published game landed with
  `multiplayer: false` regardless of the `<!--USES_MULTIPLAYER-->` marker in
  its HTML. (Studio publishes pass the flag; this partner path predates the
  flag and was never wired.)
- **Fix:** the publish route derives `multiplayer` from the same
  `MULTIPLAYER_MARKER` the preview's Invite button keys off, and passes
  `seo: { multiplayer: true }` to the partner endpoint. Only ever sent as
  true — omitted for single-player HTML, so a later republish that lost the
  marker can't silently switch an existing game's multiplayer off. The
  platform side then runs its normal entitlement gate (currently relaxed)
  and injects the lobby.
- **Result (verified):** route tests G.6 (marker → `seo.multiplayer: true`
  forwarded) and G.7 (no marker → no seo field at all); suite 816/816,
  typecheck clean.
- **Impact:** needs a deploy; the already-published race game must be
  republished once (same name/slug) to pick up the flag and the lobby.
- **Prevention:** class = "a capability derived from content must be derived
  at EVERY door the content enters through" — the partner path was a second
  door that never learned about the flag.
- **Related:** platform BUG_LOG #33/#34, marker-insurance entry below.

### 2026-07-18 — Blue-screen root cause CONFIRMED from the game's code: identical spawn point + divide-by-zero in push-apart collision → NaN position

- **Symptom:** same report as the entry below — player 2 solid blue after a
  rematch while player 1 saw both cars. The user then pasted the actual
  generated game HTML, which pinned the mechanism exactly.
- **Root cause (confirmed, two compounding gaps):** (1) `resetGame()` spawned
  EVERY player at the hardcoded point `(30, 0.4, 5)` — no per-player slots;
  (2) the push-apart collision computed `d = √(dx²+dz²)` then `dx/d` — with
  both cars byte-identical at spawn, `d === 0` → `0/0 = NaN` → the car's
  position went NaN → camera lerped to NaN → only the sky color rendered.
  The asymmetry: player 2 sat frozen at spawn while the smoothed peer
  position converged onto the exact same point; player 1 had already moved,
  so their distance never hit zero — and player 2's `broadcastState` kept
  streaming, which is why player 1 still saw both cars.
- **Fix:** two contract additions (`multiplayer-prompt.ts` + both platform
  mirrors): the roster-layout rule now REQUIRES a different starting slot
  per player (derived from roster index, sorted so all copies agree; "never
  spawn two players at the same spot"), and rule 6 now REQUIRES a
  zero-distance guard on the push-apart division, naming NaN and the
  background-color-only screen as the failure.
- **Result (verified):** 2 new contract pins (23 total in
  `multiplayer-prompt.test.ts`); Game 814/814; llms.txt 7/7; both typechecks
  clean.
- **Impact:** prompt-level; the user's race game needs one edit turn to
  absorb it ("give each player a different starting position and guard the
  collision push against divide-by-zero").
- **Prevention:** class = "vector math on peer-relative offsets must guard
  the degenerate zero-distance case, and shared spawns make that case
  routine, not rare."
- **Related:** the two rematch entries below (same UAT thread).

### 2026-07-18 — Rematch left player 2 on a solid blue screen (spawn/camera only derived in onPlayers, which never re-fires on restart)

- **Symptom (what the user saw):** owner UAT, two-device race — "we restarted
  but the second player screen shows blue while first player can see the
  other player."
- **Surface area:** `src/lib/multiplayer-prompt.ts` rule 8 (+ the two platform
  contract mirrors, synced in the same change).
- **Root cause:** restart does not change the roster, so `onPlayers` — where
  generated games put ALL spawn/camera layout, as the contract itself
  teaches — never fires again after a rematch. The restarting player resets
  through their own local path; the receiving player's reset cleared
  scores/timers but never re-placed their own car and camera, leaving the
  camera aimed at empty sky (solid blue). Player 1 still saw both cars
  because player 2's `broadcastState` kept streaming. Rule 8 (added earlier
  today) said "reset positions" but not that the reset must re-run the
  roster-layout logic itself — the exact trap.
- **Fix:** rule 8 extended: the shared reset must re-derive EVERY player's
  spawn position and the camera from the current roster (the same layout
  logic as the `onPlayers` handler), with the explicit warning that
  `onPlayers` does not re-fire on restart. Both platform mirrors
  (`AI_INTEGRATION_PROMPT.md`, `llms.txt` route) updated.
- **Result (verified):** 2 new contract pins in `multiplayer-prompt.test.ts`
  (21 total); Game 812/812; llms.txt route tests 7/7; both typechecks clean.
- **Impact:** prompt-level — games built/edited after this ships get the full
  rematch contract. The user's existing race game needs one edit turn
  ("after play again the second player's screen goes blue — fix the restart")
  to absorb it.
- **Prevention:** class = "event-driven layout + a synthetic reset event:
  any state normally derived from an event that won't re-fire must be
  re-derived explicitly in the reset path." Pinned by the new contract tests.
- **Related:** the one-race rematch entry directly below; platform BUG_LOG #33.

### 2026-07-18 — A hosted room only lasted one race: "play again" reloaded the page and killed the friend session

- **Symptom (what the user saw):** owner UAT — "host a game should last not
  for one race. it should allow multiple game restart." After a race ended,
  playing again meant re-hosting and re-sharing the invite link.
- **Surface area:** `src/lib/multiplayer-prompt.ts` (+ the two contract
  mirrors in Ariantra-Platform: `docs/AI_INTEGRATION_PROMPT.md`,
  `src/app/llms.txt/route.ts` — TECH_DEBT #41's manual sync, done in the same
  change).
- **Root cause:** the prompt's rule 5 required a "play again" button but never
  said what restart must DO. Generated games default to `location.reload()` —
  the room itself survives (2-hour TTL, server-side), but a reload tears down
  the page's WebSocket session, so the rematch was dead and the lobby had to
  be redone from scratch.
- **Fix:** new contract rule 8 — one session hosts MANY rounds: reloading the
  page to restart is forbidden by name (`location.reload()`/`location.href`);
  "play again" must reset game state in code and
  `Ariantra.broadcast({ type: 'restart' })`, applied through the same shared
  reset function as game-over (rule 5's exact pattern), so all players reset
  together.
- **Result (verified):** 3 new contract pins in `multiplayer-prompt.test.ts`
  (19 total; failed before, pass after); suite 810/810, both repos typecheck
  clean; llms.txt route tests 7/7 still green after the mirror sync.
- **Impact:** prompt-level — applies to games built/edited AFTER this ships;
  existing games keep their reload-style restart until regenerated.
- **Prevention:** class = "a UI element the contract requires must also have
  its BEHAVIOR specified — 'show a play-again button' without 'and never
  reload' invites the default that breaks the session."
- **Related:** rule 5 (shared game-over function), platform BUG_LOG #33
  (lobby rework), PRD-MULTIPLAYER.md.

### 2026-07-18 — "Multiplayer capability" built real SDK code but no invite button ever appeared (missing opt-in marker)

- **Symptom (what the user saw):** owner UAT screenshot — asked the 2-player
  race game for "multiplayer capability"; Ari replied "I've added multiplayer
  magic…" but the preview showed **no 🎮 Invite button** (and, had it been
  published, no lobby overlay).
- **Surface area:** `src/lib/multiplayer-gate.ts`, `src/app/api/chat/route.ts`
  (`toDeliverable`).
- **Root cause:** everything that surfaces multiplayer UI keys off ONE signal
  — the `<!--USES_MULTIPLAYER-->` marker the model is taught to write
  (`multiplayer-prompt.ts` rule 1). The preview's Invite button
  (`ArtifactFrame`) and the platform's publish-time lobby overlay both check
  it. The model sometimes writes genuine `Ariantra.broadcast`/`onMessage`
  game logic but forgets the marker line (especially plausible on patch-edit
  turns, where changes are expressed as hunks) — working multiplayer with no
  way to use it, while the reply claims success.
- **Fix:** `ensureMultiplayerMarker(html)` in `multiplayer-gate.ts` — if the
  delivered game calls the multiplayer SDK (`Ariantra.broadcast|onMessage|
  onPlayers(`) and lacks the marker, insert it right after `<body>` (prepend
  if no body tag); byte-identical pass-through otherwise (single-player games
  can never grow a lobby from this). Wired into `toDeliverable()` in the chat
  route — the single choke point every delivery path (patch, strict retry,
  regen fallback, fresh build) already flows through, including the
  asset-injection-failure fallback.
- **Result (verified):** 5 new unit tests in `multiplayer-gate.test.ts`
  (insertion, no-op-with-marker, no-op-single-player, body-with-attributes,
  no-body fail-soft); suite 807/807, typecheck clean.
- **Impact:** a game whose code really does multiplayer now always shows the
  preview Invite button and gets the published lobby overlay. A model that
  writes NO SDK calls still ships single-player (nothing to key off) — that
  case remains a prompt-quality issue, not a wiring one.
- **Prevention:** class = "UI gated on a model-written marker must not trust
  the model to remember the marker — derive it from the code when the code is
  unambiguous." Same day, the platform's lobby itself was reworked
  (invite-link-first hosting, platform BUG_LOG #33).
- **Related:** TECH_DEBT #43 (no reference multiplayer templates),
  platform BUG_LOG #25/#33, PRD-MULTIPLAYER.md Phase 4.

### 2026-07-18 — WhatsApp share opened nothing; the card claimed "Thanks for sharing" anyway

- **Symptom (what the user saw):** owner UAT — after publishing a game, the
  💬 WhatsApp button on the publish-done share card "led to nothing. it just
  went to thanks for sharing without going to web whatsapp".
- **Surface area:** `src/components/PublishToArcade.tsx`, `src/app/parent/page.tsx`
  (this repo) + Ariantra-Platform's `CatalogClient.tsx` and `share-overlay.ts` —
  four hand-synced copies of the same `openWhatsApp()`.
- **Root cause:** the 2026-07-17 deep-link design navigated to `whatsapp://send`
  and fell back to `window.open(wa.me)` from a 1.2 s timer. Without the app
  installed, the custom-scheme navigation silently no-ops; by the time the timer
  fires, the click's transient user activation is spent, so the popup blocker
  silently eats the `window.open` — and the blur from Chrome's own
  external-protocol dialog could cancel the fallback outright. Every call site
  then flipped to "Nice! Thanks for sharing." on a blind 300 ms timer,
  masking the failure.
- **Fix:** WhatsApp share is now a real `<a href>` to `https://wa.me/?text=…`
  (`whatsappShareUrl()` in the new `src/lib/share-links.ts`; platform mirror
  `src/lib/publish/share-links.ts`). Anchors are never popup-blocked, and wa.me
  itself hands off to the installed app (mobile + Desktop) or offers WhatsApp
  Web — the exact pattern the overlay's X/Facebook/email/SMS links already
  used. All four `openWhatsApp` copies deleted; confirm now fires on the
  anchor's click (a navigation the browser is actually performing).
- **Result (verified):** new `share-links.test.ts` in both repos (wa.me-not-
  whatsapp://, encoding); suites 802/802 (Game) and 668/668 (platform),
  typecheck clean in both.
- **Impact:** sharing works with or without a WhatsApp app; one extra wa.me tap
  when the app exists. Platform BUG_LOG #32 is the same fix from the platform
  side; TECH_DEBT #66 tracks already-published games whose baked-in overlay
  keeps the old button until republished. KNOWN_BUGS #3 tracks the sibling
  "📲 More…" fake-confirm when `navigator.share` is missing.
- **Prevention:** class = "programmatic window.open outside the click's user
  activation is a popup-block roulette — share/handoff links must be real
  anchors." The share-links tests + the banned-pattern comment in
  `share-links.ts` pin it.
- **Related:** 2026-07-17 share-copy rewrite (e9515d8, platform), PRD-SHARING S1/S5/S10.

### 2026-07-18 — "Reconnecting… hang tight!" froze the chat for up to ~12 minutes when the server was down; ⏹ Stop couldn't break it

- **Symptom (what the user saw):** owner UAT (penguin-maze session, ~8:10 PM): sent
  "speed has to be slow and change of view give a head ache" while the local dev
  server was down (a stray background server had taken :3000, so the tab's backend
  was gone). The bubble showed "📶 Reconnecting… hang tight!" and never moved on;
  the composer stayed locked (Stop button showing), Stop did nothing, and no new
  commands could be given.
- **Surface area:** `src/lib/turn-resume.ts` (`pollTurnResult`),
  `src/components/ChatPanel.container.tsx` (reconnect branch of `runStream`,
  `handleStop`).
- **Root cause:** two gaps in the stream-recovery design (TECH_DEBT #23), which was
  tuned for "server alive but slow" and never considered "server unreachable":
  1. every network-level poll failure counted as a patient "offline tick", so a dead
     server consumed the FULL 4-minute resume budget — per attempt. With the
     2-retry limit that's ~12 minutes of frozen banner before the honest
     "connection keeps hiccuping" message.
  2. `handleStop` only aborts the in-flight stream fetch (`abortRef`); during the
     poll phase there is nothing to abort and `manualStopRef` was only consulted
     AFTER `pollTurnResult` returned — the kid's ⏹ was dead for minutes.
- **Fix:** `pollTurnResult` now (a) tracks whether the server has answered at all
  this poll (`reached`); until it has, the budget is `UNREACHABLE_MAX_MS` (20s)
  instead of 4 minutes — once any HTTP response arrives, full heavy-load patience
  applies as before; (b) takes `shouldStop` and honors it every tick. The container
  passes `shouldStop: () => manualStopRef.current`.
- **Result (verified):** 3 new unit tests in `turn-resume.test.ts` (fail-fast when
  never reachable; full patience preserved once the server answered; shouldStop
  breaks the poll at the next tick). All fail before the fix, pass after; suite
  799/799, typecheck clean.
- **Impact:** worst case with a dead server drops from ~12 minutes to ~1 minute
  before the kid gets the "ask me again" message; ⏹ unlocks the composer within
  one 4s tick at any point in the reconnect wait. The heavy-load resume path
  (server genuinely still generating) is unchanged.
- **Prevention:** class = "retry loops must distinguish 'slow' from 'dead' and stay
  interruptible." The three tests above pin both properties.
- **Related:** BUG-FIX-LOG 2026-07-09 (auto-retry), TECH_DEBT #23 (resumable
  generations), 2026-07-07 (never discard streamed partials).

### 2026-07-18 — Repeat-mic, take 3: a successful restart re-opened the replay-flood window (found by the new mic e2e)

- **Symptom (what the user saw):** field report "the mic is not good" (Chrome, HP
  laptop). Reproduced in `scripts/e2e-mic-dictation.mjs` (real Chromium against the
  running app, scripted SpeechRecognition fake): after a successful silent restart, a
  later failed restart let the lingering old session's cumulative finals re-commit —
  "make me a maze game with penguins in 3d **make me a maze game with penguins in
  3d** please".
- **Surface area:** `src/lib/speech-transcript.ts`, `src/components/useSpeechInput.ts`.
- **Root cause:** counters can't distinguish "fresh session's new list" from "old
  session's stale list". Take 2 (2026-07-16) kept the counter on a FAILED start, but a
  SUCCESSFUL restart legitimately zeroes it — if the old session then resurfaces via a
  later restart race in the same listen, every stale final sits "past" the zeroed
  counter and re-commits. A second leak: the interim tail flushed by `onend` was
  committed to the composer without being recorded, so a stale list re-delivering it
  as a real final slipped past any guard.
- **Fix:** the caller now also passes the committed TEXTS (`committedTextsRef`, reset
  only on a kid-initiated start): `dropReplayedPrefix()` drops two-or-more consecutive
  already-committed finals reappearing at the head of the fresh slice
  (`MIN_REPLAY_RUN = 2` — a single match is deliberately let through, a kid may really
  say the same phrase twice). The onend interim flush records its text too.
- **Result (verified):** 5 new `speech-transcript.test.ts` cases (2 failed before,
  pass after) and the new 14-check mic e2e all green; suite 796 passing.
- **Impact:** replay floods are now text-impossible across all three known paths
  (stale resultIndex, failed restart, stale-list-after-successful-restart). Remaining
  edge (documented): a kid repeating 2+ identical consecutive phrases across a silence
  restart could be over-deduped; wrong-word complaints are the recognizer itself, not
  this wiring.
- **Prevention (class):** "session-scoped counters guarding cross-session streams —
  identity must come from content, not position." Pinned by
  `scripts/e2e-mic-dictation.mjs` (run: dev server + `node scripts/e2e-mic-dictation.mjs`).
- **Related:** 2026-07-14 repeat-mic, 2026-07-16 take 2 (same class, both still pinned).

### 2026-07-18 — Every edit turn failed `search_not_found`: the model was shown an OLD game version while applyPatch targeted the newest

- **Symptom (what the user saw):** live UAT after the strict-retry hardening — every
  single edit request logged `patch failed (search_not_found) — falling back to full
  regeneration`; one regeneration then rebuilt the current 3D maze as a 2D game with
  broken controls (built from a stale version).
- **Surface area:** `src/lib/history-trim.ts` (`hasGame`, `trimHistory`); interacts
  with `src/app/api/chat/route.ts`'s patch branch and `src/lib/game-edit.ts`.
- **Root cause:** two "current game" definitions diverged. `applyPatch` targets
  `currentGameHtml()` — the newest message's `artifactHtml` FIELD. But the model's
  view of the conversation (`trimHistory`) located "the current game" by scanning
  message TEXT for a code fence. A patch/fallback turn stores prose-only text (the
  game travels only in the field), so from the second edit onward the model saw an
  older version's code as current, copied its lines into SEARCH blocks, and the patch
  could never match the true source — self-perpetuating, since every failed turn
  stored another prose-only message. This also retro-explains most of the penguin-maze
  session's fallback loop.
- **Fix:** `hasGame` now checks the `artifactHtml` field first (same signal
  `game-edit.ts`'s `lastGameIndex` uses; text scan kept for legacy messages), and new
  `withInlineGame()` re-inlines the current game's source from the field into the text
  the model sees — so the lines the model copies are byte-identical to the lines
  `applyPatch` searches.
- **Result (verified):** 5 new `history-trim.test.ts` cases (prose-only game messages
  found, re-inlined, still stripped when stale, pin honored, never double-inlined) —
  failed before, pass after; suite 791 green.
- **Impact:** minimal patches can now actually apply on multi-edit conversations; a
  regeneration fallback builds from the TRUE current version instead of a stale one.
- **Prevention (class):** "two modules answering the same question ('which version is
  current?') from different signals WILL diverge — derive both from one source." New
  route debug line logs the patch-target source + `inSource=` check of the model's
  first SEARCH block, which makes any recurrence obvious from the log alone.
- **Related:** penguin-maze entry below; `route.ts` `logSearchMiss` diagnostics.

### 2026-07-18 — Raw SEARCH/REPLACE hunks streamed live into the chat bubble ("not kid friendly")

- **Symptom (what the user saw):** screenshot from live UAT — while an edit reply was
  generating, the bubble showed `<<<<<<< SEARCH window.addEventListener('resize'…`
  plus raw code to the child. The server-side prose split (`editReplyProse`) only
  runs when the stream finishes, so every partial render leaked the raw reply.
- **Surface area:** `src/components/ChatPanel.container.tsx` (all partial-text
  renders), `src/lib/game-edit.ts`.
- **Root cause:** the delta handler set the raw accumulated stream text straight into
  the bubble (`setReply(acc)`), and the stop/retry/error paths re-showed `acc` raw too.
- **Fix:** new pure `streamingDisplayText()` (game-edit.ts) — cuts at the first run of
  four-or-more `<` (catches a marker still arriving at the stream tail) and shows the
  prose plus a friendly `EDIT_STREAM_WORKING_LINE`; applied at every `setReply` site
  that renders partial text (delta, stop, reconnect, error-keep-partial).
- **Result (verified):** 4 new `game-edit.test.ts` cases — failed before, pass after.
- **Impact:** a child never sees patch markers or hunk code mid-stream; finished
  messages were already clean.
- **Prevention (class):** "server-side output cleaning must have a client-side twin
  for STREAMING partials — anything rendered mid-stream needs its own sanitizer."
- **Related:** penguin-maze entry below (same feature); `MessageItem` markdown code
  cards (fenced full-game code during fresh builds) are unchanged, deliberate.

### 2026-07-18 — Patch-based edits almost never engaged: 17 of 18 real edit turns silently rewrote the whole game ("penguin maze" session)

- **Symptom (what the user saw):** live UAT, the "Make me a maze game with penguins 🐧"
  chat — 18 edit turns over 76 minutes without landing a single change: controls
  flipped, colors changed uninvited, the road became invisible, four turns delivered a
  blank game, four replies were a bare "Here's your game! 🎮", and the child pasted the
  identical request three times because each reply claimed success without the change
  appearing. The user gave up after 45+ minutes on what was one camera/viewport issue.
- **Surface area:** `src/app/api/chat/route.ts` (edit branch), `src/lib/game-edit.ts`,
  `src/lib/gemini.ts` (`configFor`, `extractArtifact`).
- **Root cause:** `applyPatch()`'s `mode: "regeneration"` loophole. When the model
  ignored the SEARCH/REPLACE contract and emitted a full document, the route accepted
  it as a successful "edit" (guarded only by `looksLikeCompleteDocument`). Measured
  against the real conversation's stored artifacts: only 1 of 18 turns produced a true
  minimal patch (88% line carry-over); the other 17 rewrote ~half the file each
  (31–56% carry-over) — the exact regression machine the feature was built to prevent,
  running with a success log line. Compounding it: rebuilds shipped with bare success
  prose implying a targeted change, and an identical re-sent request (the clearest
  "your last reply didn't work" signal) got the same flow and the same success claim.
- **Fix:**
  - Strict retry: a full-document reply on an edit turn no longer counts as silent
    success — ONE hunks-only retry (`GeminiChatModel.strictEditRetry`, gemini.ts;
    `GAME_EDIT_STRICT_RETRY_SECTION` with a `NEEDS_FULL_REBUILD` honest-out sentinel,
    game-edit.ts) against the same source; a clean retry patch wins, anything else
    accepts the original rewrite (floor unchanged: "no worse than before").
  - Honest messaging: accepted rewrites and the `forceFullRegen` fallback never show a
    bare success line — `regenReplyProse()`/`REBUILT_GAME_LINE` say a whole-game
    rebuild happened and invite the child to report anything that broke.
  - Repeat escalation: `isRepeatedRequest()` + `REPEATED_REQUEST_SECTION` tell the
    model its previous reply did NOT work and to change approach, not re-claim success.
  - Kill switch: `GAME_EDIT_PATCH=off` (checked in `patchEditsEnabled()`, gated inside
    `isGameEditTurn()` so one choke point reverts both call sites) restores exact
    pre-patch behavior — the user's guaranteed rollback, documented in `.env.example`.
- **Result (verified):** 12 new tests fail-before/pass-after (`game-edit.test.ts` 34
  total, `route.test.ts` "patch-based feature edits" 12 total); full suite 782 passing,
  typecheck clean. Session evidence from the local SQLite conversation record
  (artifact-hash + line-carry-over analysis per turn).
- **Impact:** edit turns can no longer silently regress untouched parts of a game
  without at least one enforced patch attempt; a rebuild is always labeled as one; a
  frustrated repeat changes the model's strategy instead of repeating it; and the whole
  feature can be switched off in one env flip if it misbehaves.
- **Prevention (class):** "a fallback acceptance path can quietly become the MAIN path
  — measure how often each branch actually fires against real sessions, and never let
  a fallback report itself as the success case." The `✓ edit patch` vs `edit
  regeneration accepted` vs `strict retry` log lines now make the split observable.
- **Related:** the two 2026-07-18 entries below (same feature, same day); deferred
  headless blank-canvas check + screenshot feedback loop → platform `TECH_DEBT.md`
  #64/#65 (4 of the 18 turns shipped a game that rendered nothing — not catchable
  server-side without a browser).

### 2026-07-18 — The idea mic button (and Idea Bag) was invisible on every ordinary game preview

- **Symptom (what the user saw):** live UAT (local `next dev`, Chrome) — "when
  the preview loads, the idea mic button is not visible." Confirmed: never
  appears, however long you wait, in a browser with full Web Speech support.
- **Surface area:** `src/components/ArtifactFrame.tsx` (the panel-size
  `ResizeObserver` and the Idea Button/Bag overlay sizing that reads it).
- **Root cause:** the overlay hosting `IdeaMicTab`/`IdeaBag` is absolutely
  positioned and sized from JS-measured `panelSize` state whenever no device
  frame (Tablet/Phone/Laptop) is active — `width: previewFramed ?
  previewOriented.width! : panelSize.w` (same for height). But the
  `ResizeObserver` that populates `panelSize` explicitly skipped measuring
  whenever `device === "fit"` (comment: "Track the panel's size while a
  device frame is shown") — and `"fit"` is BOTH `useState`'s initial value
  AND what a separate effect resets `device` to on every new game ("new game
  → verify at panel size"). So on the ordinary, default preview (no frame
  selected — the common case, not an edge case), `panelSize` never left its
  initial `{ w: 0, h: 0 }`, and the overlay rendered at `width:0; height:0` —
  present in the DOM, permanently invisible. The iframe itself was unaffected
  (sized via CSS `h-full w-full`, not `panelSize`), so the game always
  rendered fine while the mic/bag silently vanished.
- **Investigation note:** first ruled out two more likely-looking causes
  before finding this — (1) the unrelated, uncommitted "Continue from here"
  pin feature (`chat-rewind.ts`) touches only the chat message list, not
  `ArtifactFrame`/z-index/layout at all; (2) `isSupported` (Web Speech API
  detection) was confirmed correct and browser-standard. Asked the user two
  targeted questions (browser? does it ever appear after a delay?) — "Chrome,
  never" ruled out both hypotheses and pointed at layout/sizing instead.
- **Fix:** `src/components/ArtifactFrame.tsx` — removed the `device ===
  "fit"` early-return from the `panelSize` `ResizeObserver` effect; it now
  measures the panel in every device mode, not only while a frame is shown.
- **Result (verified):** full suite 764/764 green (unaffected — this
  component has no unit-test harness, consistent with several other complex
  UI pieces in `docs/REGRESSION-TEST-CATALOG.md`; verification here is via
  the user's own live `next dev` session with hot reload). `npx tsc --noEmit`
  clean.
- **Impact:** the Idea Button and Idea Bag are visible again on the default
  (real-device/"fit") preview — the mode virtually every kid sees, since a
  Tablet/Phone/Laptop frame is an opt-in toggle, not the default.
- **Prevention — name the class:** *a performance/scope guard on a measurement
  effect outliving the assumption that justified it* — the `device ===
  "fit"` skip was written when (presumably) `panelSize` was ONLY read by
  framed-mode code; a later change (the overlay's fallback sizing) started
  reading the SAME state in the unframed case too, without revisiting whether
  the skip still made sense. When a piece of state gains a new reader, check
  every guard on what populates it.
- **Related:** none prior (first bug logged against `ArtifactFrame.tsx`'s
  panel-size measurement).

### 2026-07-18 — A malformed/partial edit reply could leak raw patch markers into the chat or silently replace the whole game with a fragment

- **Symptom (what the user saw):** live UAT right after the patch-based
  feature-edit deploy — "it build poor quality game. the chat window is not
  user friendly. multiple blocks and not working code."
- **Surface area:** `src/app/api/chat/route.ts` (the edit-turn branch added
  for patch-based feature edits), `src/lib/game-edit.ts`.
- **Root cause:** the edit-turn branch treated `applyPatch()`'s `ok:false,
  reason:"no_patch_in_reply"` as ALWAYS meaning "the model just answered
  off-topic, safe to show as plain chat" — but that's also exactly what
  happens when the model attempts an edit and the attempt comes out
  malformed: a truncated/incomplete `<<<<<<< SEARCH` block with no closing
  `REPLACE`, for instance, has no COMPLETE match for `applyPatch`'s regex, so
  it falls into that same "no patch found" bucket, and the raw
  literal markers/fragments got dumped straight into the chat bubble
  (unfenced — CommonMark then renders the indentation as several stray
  "code block" widgets, the reported "multiple blocks"). Separately,
  `applyPatch`'s "regeneration" fallback mode (meant to tolerate a model that
  ignores the patch instruction and returns a full replacement file) trusts
  ANY ` ```html ` fence as if it were that full file — if the model instead
  wrote an explanatory "here's the changed part" with a PARTIAL snippet
  fenced the same way, that fragment was accepted as `ok:true,
  mode:"regeneration"` and would silently become the ENTIRE game
  ("not working code" — a bare fragment instead of a playable page).
- **Regression test FIRST:** `src/lib/game-edit.test.ts` (new
  `looksLikeAttemptedEdit`/`looksLikeCompleteDocument` describe blocks, 7
  tests) and `src/app/api/chat/route.test.ts` (2 new cases: a truncated patch
  attempt must never leak `<<<<<<<` into `done.text`; a partial snippet must
  never become `done.artifactHtml`) — both reproduced against the pre-fix
  code (raw markers visible in the chat text; the bare snippet accepted as
  the new game) before the fix, passed after.
- **Fix:** `src/lib/game-edit.ts` — two new pure guards:
  `looksLikeAttemptedEdit()` (patch markers, a code fence, or raw HTML/script
  tags anywhere in the reply — tells a genuinely off-topic answer apart from
  a mangled edit attempt) and `looksLikeCompleteDocument()` (requires both an
  opening and closing `<html>` tag). `src/app/api/chat/route.ts`'s edit
  branch now only trusts a `mode:"regeneration"` result when
  `looksLikeCompleteDocument` passes, and only takes the "off-topic chat"
  passthrough when `no_patch_in_reply` AND `!looksLikeAttemptedEdit(full)` —
  anything else (a malformed attempt, or an incomplete "regeneration") falls
  to the SAME full-regeneration safety net already built for a clean-but-
  mismatched patch, so a bad reply is retried once rather than ever shown
  raw or silently corrupting the game.
- **Result (verified):** full suite 764/764 green (up from 755);
  `npx tsc --noEmit` clean.
- **Impact:** an edit turn can no longer leak literal `<<<<<<< SEARCH`-style
  text into the chat, and can no longer replace a whole game with a partial
  snippet — both degrade to the existing full-regeneration fallback instead,
  same floor as before patch-based editing shipped.
- **Prevention — name the class:** *a "no signal found" branch conflating two
  different causes* — `no_patch_in_reply` was treated as one outcome
  ("nothing to do here") when it actually covers two: genuinely nothing
  attempted, and something attempted but too broken to parse. Whenever a
  parser's "not found" result feeds a routing decision, check whether
  "not found because never attempted" and "not found because malformed" need
  different handling before assuming they're the same case.
- **Related:** 2026-07-18 "Patch-based feature edits" (the entry that
  introduced this branch); 2026-07-18 "Patch-mismatch fallback ... dead-ended
  on a bad/unavailable model" (a different bug in the same feature's fallback
  path, already fixed).

### 2026-07-18 — Patch-mismatch fallback and self-healing repair dead-ended on a bad/unavailable model, even though the main answer recovered fine

- **Symptom (what the user saw):** live UAT of the new "Continue from here" pin
  feature (chat-rewind.ts) — the pinned edit's first turn eventually produced a
  game after ~30s (slow but worked), but the self-heal that followed failed
  silently, and a second edit attempt died outright with **"Oops! Something
  went wrong. Let's try again."** with no game and no way to recover short of
  starting a brand-new build. Not actually a bug in the pin feature — the log
  showed `edit=true` and the SEARCH/REPLACE mechanism engaging correctly
  against the pinned version both times.
- **Surface area:** `src/lib/gemini.ts` (`GeminiChatModel.reply()`, `.repair()`).
- **Root cause:** `GEMINI_CHAT_MODEL` was misconfigured (`emini-3-flash-preview`
  — missing the leading "g"), so every call to the primary model 404'd
  (`models/emini-3-flash-preview is not found`). `replyStream()` (the main
  streamed answer) has a 4-deep fallback chain (`PRD-MODEL-FALLBACK`) and
  recovered on its own by walking to `gemini-2.5-flash` — which is why the
  first turn eventually worked. But `reply()` (the "patch didn't cleanly
  match → do one full regeneration" safety net used by
  `api/chat/route.ts`'s patch-fallback path) and `repair()` (self-healing
  preview, PRD §7) both called `this.model` directly with **no fallback chain
  at all** — a leftover gap from when the patch-fallback path was added
  (2026-07-18, patch-based feature edits), which never gave `reply()` the
  same resilience `replyStream()` already had. So the exact moment either
  safety net was needed (a patch not matching — a normal, expected,
  occasional occurrence — or a generated game failing to load), it hit the
  same 404 with nothing to catch it.
- **Fix:** extracted `oneShotWithFallback()` on `GeminiChatModel` — the same
  chain-walk policy `replyStream()` uses (primary keeps its own retry count,
  each fallback gets ONE attempt, `shouldTryNextModel` decides whether a
  failure walks the chain or throws immediately) — and routed both `reply()`
  and `repair()` through it instead of calling `this.model` directly
  (`src/lib/gemini.ts`).
- **Result (verified):** new `src/lib/gemini.oneshot-fallback.test.ts` (5
  tests) reproduces the live incident's exact error string and confirms both
  methods now fall back correctly while a genuine non-transient error (400/403)
  still throws immediately, no fallback call burned. Confirmed the tests
  actually pin the bug: `git stash`-ing just `gemini.ts` back to the pre-fix
  version and re-running failed 3 of the 5 new tests with the exact same "chat
  generation failed: 404 NOT_FOUND" / "repair generation failed: 404
  NOT_FOUND" errors from the live log. Full suite 755/755 green;
  `npx tsc --noEmit` clean.
- **Impact:** a single bad/retired/temporarily-unavailable primary model id
  (misconfiguration OR a genuine transient Google-side outage) can no longer
  dead-end an edit turn or a self-heal — both now recover the same way the
  main streamed answer already does. No behavior change on the happy path.
- **Prevention — name the class:** *inconsistent resilience across sibling
  code paths* — a fallback/retry mechanism added to ONE entry point
  (`replyStream()`, 2026-07-11) silently didn't cover a SECOND entry point
  added later (`reply()`'s patch-fallback, 2026-07-18) that shares the same
  failure modes. When adding a new one-shot model call, route it through
  `oneShotWithFallback()` rather than calling `this.model` directly.
- **Related:** 2026-07-18 "Patch-based feature edits" (the entry that added
  `reply({forceFullRegen:true})` without this resilience);
  `docs/PRD-MODEL-FALLBACK.md`; chat-rewind.ts "Continue from here" (the
  feature under test when this surfaced — itself unaffected).

### 2026-07-18 — "medic kit" (and any two innocent words colliding across a space) hard-blocked as profanity

- **Symptom (what the user saw):** repeatedly rephrasing a game-feature request — "enemy can pick
  medic kit and increase his life" — got an instant "kind redirect" hard-block on every attempt
  (`[api/chat] input-rules action=hard_block @0-1ms` in the pm2 log, `userId=user:ashokn14@iimklive.com`),
  even though the message has nothing objectionable in it.
- **Surface area:** `src/lib/safety.rules.ts` (`RulesClassifier.classifySync`, the Layer-0
  deterministic pre-check that runs before any Gemini call).
- **Root cause:** `normalize()` lowercases the ENTIRE message and strips all whitespace/punctuation
  before substring-matching against `BLOCK_WORDS` — deliberately, so letter-spaced evasion
  ("f u c k") and multi-word self-harm phrases ("kill myself") are still caught. But stripping the
  space between two unrelated real words merges them too: "medic kit" → "medickit", and "medi**c**"
  + "**k**it" spells "dick" right at the boundary (classic Scunthorpe-problem substring collision).
  Reproduced deterministically by running the actual `normalize()`/`BLOCK_WORDS` logic against the
  reported message — matched `"dick"` at index 63 of the normalized string.
- **Fix:** split `BLOCK_WORDS` into two lists with two different matching strategies. `PROFANITY`
  (`fuck`, `shit`, `bitch`, `asshole`, `bastard`, `dick`, `pussy`, `sex`, `porn`, `nude`, `naked`,
  `rape`) is now matched **per whitespace-delimited word token** via new `collapseSpelledOutLetters()`
  — it merges only *consecutive single-character* tokens together first (so "f u c k" still becomes
  "fuck" and gets caught), leaving genuine short words ("medic", "kit", "to", "an") as separate
  tokens that never get glued to a neighbor. `SELF_HARM` (`suicide`, `killmyself`, `killyourself`,
  `selfharm`, `cutmyself`) keeps the old whole-string-concatenation check, since those are
  intentionally meant to span real word boundaries ("kill myself", "cut myself"). Rejected
  alternative: allowlisting "medic kit" specifically — fixes the symptom, not the class; the same
  boundary collision could recur with any other word pair.
- **Result (verified):** new `src/lib/safety.rules.test.ts` (8 tests) — "medic kit" now `allow`;
  letter-spaced ("f u c k"), punctuation-obfuscated ("d.i.c.k"), and leetspeak ("sh1t") evasion
  still `hard_block`; a standalone real blocked word next to an innocent one ("sex ed") still
  `hard_block`; self-harm phrases across real word boundaries ("kill myself", "cut myself") still
  `hard_block`. All failed against the pre-fix code except the pre-existing-behavior ones; pass
  after. Full suite 708/708 green (up from 700); `tsc --noEmit` clean.
- **Impact:** legitimate game-design/creative messages that happen to contain two ordinary words
  colliding at a boundary are no longer wrongly hard-blocked; the letter-spacing and self-harm
  evasion paths this filter exists for are unaffected. Does **not** cover every conceivable
  adversarial obfuscation (e.g. mixing spaces and punctuation within the same evasion attempt) —
  same residual gap the pre-fix code had, and the background LLM safety check remains the second
  line of defense for anything the deterministic Layer-0 rule doesn't catch.
- **Prevention:** `src/lib/safety.rules.test.ts` locks the word-boundary behavior; regression class
  is "any BLOCK_WORDS entry short enough to appear at the seam of two unrelated real words" — a
  future addition to `PROFANITY` should stay in the per-token list, not get added to `SELF_HARM`'s
  whole-string check, unless it's genuinely meant to span words.
- **Related:** none prior (first bug logged against `safety.rules.ts`'s matching mechanism).

### 2026-07-18 — Recent chats missing after guest→account signup, and after a subdomain rename

- **Symptom (what the user saw):** "I don't see the full list of my chats on the recent chats
  section" — fewer chats than before, live on `games-lab.ariantra.com`. User confirmed: chatted
  as a guest first, created an account afterward.
- **Investigation:** the 2026-07-17 "Recents not seen" entry (below) had already ruled out an
  identity split for the account it checked (DB had all rows correctly keyed, including guest-era
  chats) — so this needed its own root-cause pass rather than assuming the same cause. Traced the
  actual guest→account code path end to end (no production DB access needed — the bug reproduces
  from source).
- **Surface area:** `src/lib/chat-sync.ts` (`SYNC_FLAG`), `src/components/ChatPanel.container.tsx`
  (bootstrap), `src/app/api/chats/route.ts`, `src/lib/db.ts`
  (`SqliteChatHistoryStore`), `src/app/api/chat/route.ts` (`guestCookieHeader`).
- **Root cause — two independent bugs, both closing the same symptom class:**
  1. **The guest→account chat migration only ever existed client-side, and is gated by an
     identity-agnostic one-shot flag.** `POST /api/chats` bulk-migrates whatever conversations are
     cached in the browser's `localStorage` at that moment — there was no code anywhere (this repo
     or the sibling Ariantra-Platform SSO repo) that queried the `conversations` table for rows
     under the guest's old `userId` and reassigned them to the account. Worse, that client POST is
     gated by `SYNC_FLAG` (`chat-sync.ts:8`), a single `localStorage` flag with no identity
     awareness: it's set the first time it ever succeeds — almost always *while still a guest*,
     mid-session — and login (a full-page redirect back into the app) never resets it. So by the
     time a guest signs up, the one-shot migration has usually already fired and permanently
     skips itself on every future mount, including the post-login one. Any chat not sitting in
     that exact localStorage snapshot stays parked under the old `guest:<uuid>` row forever.
  2. **The guest cookie (`ari_guest`) was host-only** (`guestCookieHeader`, no `Domain=` attribute)
     — unlike the shared SSO `ariantra_session` cookie (`Domain=.ariantra.com`). A canonical-domain
     rename (`kidgemini.ariantra.com` → `ari.ariantra.com` → `games-lab.ariantra.com`, three times
     in two days) mints a brand-new guest identity on the new host, so even a same-day guest→account
     conversion can lose the trail if a rename happened in between.
- **Fix:**
  - `src/types/chat-history.types.ts` / `src/lib/db.ts`: new `ChatHistoryStore.claim(fromUserId,
    toUserId)` — a single indexed `UPDATE conversations SET userId = ... WHERE userId = ... AND id
    NOT IN (...)` that reassigns every row from one identity to another; skips (never overwrites)
    an id the target already owns.
  - `src/app/api/chats/route.ts` (`GET`): the moment a request resolves to a signed-in `user:`
    identity that *also* still carries the (httpOnly) guest cookie, calls `store.claim(guestId,
    userId)` before listing. This route is unconditionally called on every app mount — including
    the post-login remount — regardless of `SYNC_FLAG`, so it's the one reliable choke point.
    Idempotent and cheap once already claimed (indexed no-op).
  - `src/app/api/chat/route.ts` (`guestCookieHeader`): guest cookie now carries `Domain=.ariantra.com`
    in production (same `SESSION_COOKIE_DOMAIN` knob and pattern as `/api/logout`), so it survives
    future canonical-domain renames instead of being reminted.
- **Result (verified):** new tests — `db.chat-history.test.ts` H.7–H.9 (claim reassigns rows,
  leaves the account's own chats alone, no-ops when nothing to claim); `chats.route.test.ts`
  C.8–C.10 (login-time claim end to end, guest-only requests never claim, claiming twice is safe);
  `chat/route.test.ts` G.1c/G.1d (`Domain=.ariantra.com` in production, host-only in dev). Full
  suite 700/700 green (up from 676); `tsc --noEmit` clean; `npm run build` clean.
- **Impact:** signing in while the browser still holds a guest cookie now folds that guest's whole
  chat history into the account, regardless of what's left in `localStorage`. Guest identity now
  survives a subdomain rename going forward. Does **not** retroactively recover chats already
  orphaned under a guest id the current browser no longer sends (e.g. this user's chats from
  before today's rename, if the old host's cookie was lost) — recovering those needs either the
  user still holding the old host's cookie (visiting the old subdomain directly triggers the same
  claim) or a one-time production DB reconciliation, not done here (no prod DB access in this
  pass).
- **Prevention:** class = **migration state that lives client-side and isn't identity-aware**, and
  **an identity cookie scoped narrower than the identity it's supposed to survive across**. Any
  other one-shot `localStorage` flag gating a server write is the same risk shape.
- **Related:** 2026-07-17 "Recents not seen" entry below (ruled out identity-split for a different
  account, motivating a fresh investigation here rather than reusing that conclusion);
  `UAT_SSO.md` known limitations (the *separate*, already-accepted Google-vs-credentials identity
  split — unaffected by this fix, still open).

### 2026-07-17 — Batch fix: Critical/High/Medium error-handling & logging audit findings

- **Symptom (what the user saw):** none directly reported — this closes findings from a
  cross-repo audit (Platform + kidgemini) the user requested after the Recents-fetch-failure
  fix earlier the same day. See `../Ariantra-Platform/docs/BUG_LOG.md` #28 for the sibling
  Platform entry.
- **Scope:** 12 of the 14 kidgemini findings rated Critical/High/Medium (0 Critical here — the
  one Critical was Platform's signaling process). The other 2 (`UpgradePlans.container.tsx`'s
  checkout status-code leak and silent `alreadyPaid` check) were explicitly deferred per owner
  steer — billing isn't live yet — tracked in `../Ariantra-Platform/docs/TECH_DEBT.md` #54.
- **Root cause (class, not one bug):** same two patterns as the Platform sibling entry —
  bookkeeping writes (`usage.record`, payment confirmation) sat outside the try/catch their
  sibling calls already used ("bookkeeping must never break chat" was violated by exactly the
  calls that should have honored it), and three near-identical cross-app fetches had no
  network-failure handling at all.
- **Fix, by area:**
  - **Process-level crash logging:** new `src/instrumentation.ts` + `experimental.
    instrumentationHook` in `next.config.js` — logs `unhandledRejection`/`uncaughtException`
    instead of the app having zero trail if one ever happens. Preventive, not reactive: the
    box's 70 pm2 restarts (investigated the same day, see below) turned out to be clean,
    deploy-triggered `pm2 restart` calls (exit code 0, SIGINT) — zero actual crashes, so this
    isn't fixing an observed problem, just closing a real gap (nothing was watching for one).
    **First attempt broke the production build**: dynamically importing `@/lib/logger` from
    `instrumentation.ts` failed to compile
    for the edge-runtime bundle variant (`node:fs`/`node:path` aren't edge-compatible, and
    webpack needs to COMPILE both variants regardless of a runtime guard) — caught by the
    plan's own `npm run build` verification step, fixed by dropping that import and keeping
    instrumentation.ts to plain `console.error` (no fs dependency, edge-bundle-safe).
  - **Logger rotation:** `src/lib/logger.ts` was an unbounded append-only file on a box that
    already pm2-restarts kidgemini at a 350MB ceiling out of 908MB total. Pure rotation check
    extracted to new `src/lib/log-rotate.ts` (logger.ts itself imports `"server-only"`, which
    isn't resolvable in vitest — this is also why no test existed for logger.ts before).
    10MB ceiling, rotate-to-`.1`. Tests: `log-rotate.test.ts` (4 cases, real temp files).
  - **Unguarded bookkeeping writes:** `api/chat/route.ts`'s `recordUsage(...)` now runs through
    the existing `trackTurn(...)` wrapper (zero new code shape — reuses what was already there
    for the sibling `turnResults` calls). `api/repair/route.ts`'s `usage.record({...})` wrapped
    locally — previously a DB write failure turned an already-successful repair into a 500 for
    the kid, for a reason unrelated to the repair itself.
  - **Billing:** `api/billing/verify/route.ts` and `api/billing/webhook/route.ts` — `getByOrderId`/
    `markPaid`/`isNewEvent` wrapped with logging before returning a clean 500 (verify) or
    rethrowing (webhook, preserving Razorpay's retry semantics unchanged) — same DB-call
    outcome as before, just diagnosable from `app.log` now instead of a bare stack trace.
  - **Arcade fetches:** `api/arcade/publish`, `api/arcade/test-link`, and `api/parent/games` had
    three copy-pasted, near-byte-identical `partner()` implementations, none guarding the
    `fetch()` itself against a network failure/hang. Extracted to one shared
    `src/lib/arcade-partner.ts` (try/catch → clean 502, `AbortController` timeout) — one fix
    instead of three, and the three routes can no longer drift apart. Tests:
    `arcade-partner.test.ts` (4 new cases).
  - **`lib/db.ts`'s ~35 raw `getDb().prepare()` call sites deliberately NOT wrapped** — no
    existing shared choke point, and fail-open-vs-closed genuinely differs per call site; the
    two that mattered (usage recording, payment confirmation) were handled above at the call
    site instead. Tracked as its own design pass: `../Ariantra-Platform/docs/TECH_DEBT.md` #53.
  - **Messaging (same shape as the fix below this entry, found live in two more places):**
    `PublishToArcade.tsx`'s existing-games fetch got the same `gamesLoadError`/retry pattern
    as `Sidebar.tsx`'s `recentsError` (a failed fetch previously looked identical to "zero
    games," silently routing a kid into "publish new" instead of offering "update").
    `ChatPanel.container.tsx`'s two silent write-through `.catch(() => {})` sites (the exact
    failure class the file's own comments already name — "I lose chat across browsers") now
    log a client-side breadcrumb.
  - **Data retention (documented, not changed):** new `docs/DATA_HANDLING.md` — full kid chat
    text and generated game code are retained indefinitely in SQLite, admin-readable via
    `/api/usage?detail=true`. Retention policy is flagged as an open product/legal decision,
    not resolved by this pass (owner steer: document only, no behavior change).
- **Result (verified):** full suite green (84 files / 684 tests, up from 676 before this pass),
  `tsc --noEmit` clean, `npm run build` clean (after the instrumentation fix above) with
  `instrumentationHook` confirmed active. `PublishToArcade`'s retry notice verified live via
  Playwright (mocked session + a forced 500 on the games-list fetch) — screenshot-confirmed.
- **Impact:** no user-visible behavior change on any success path — every fix is additive (a
  catch that was missing, a log line that was missing, a shared helper replacing three copies).
- **Prevention:** class = **bookkeeping write outside its sibling's established try/catch
  pattern**, and **build-breaking edge-runtime bundling of a Node-only module** — the latter is
  exactly why the plan mandated a real `npm run build` check for this kind of change, not just
  typecheck + tests.
- **Related:** `../Ariantra-Platform/docs/BUG_LOG.md` #28 (sibling Platform entry);
  `../Ariantra-Platform/docs/TECH_DEBT.md` #53/#54 (deliberately deferred items).

### 2026-07-17 — Recent chat history "not seen" — silent Recents fetch failure, no data loss

- **Symptom (what the user saw):** "even now the chat history on the recent side is not seen" —
  signed in with Google, same device/browser the chats were made on, sidebar's Recent section
  showed nothing.
- **Investigation (production, read-only):** compared `AUTH_JWT_SECRET` hashes between the
  platform and kidgemini on the EC2 box (match — rules out the secret-drift risk in
  `TECH_DEBT.md` #20); queried the live SQLite `conversations` table directly — the account
  (`user:<email>`) had 8 rows correctly keyed, including guest-era chats published after signing
  in (rules out the login-method identity split documented in `UAT_SSO.md`). No server-side data
  loss and no identity-split occurred for this account.
- **Surface area:** `src/components/ChatPanel.container.tsx` (`loadMoreRemote`),
  `src/components/Sidebar.tsx` (Recents list).
- **Root cause (this specific incident, unconfirmed):** most likely a stale client bundle after a
  redeploy — production logs showed repeated `Failed to find Server Action... this request might
  be from an older or newer deployment` around the same window. The pm2 restart count was
  investigated separately the same day and turned out to be unrelated (see the 2026-07-17 "Batch
  fix" entry above) — every one of kidgemini's 70 restarts is a clean, deploy-triggered
  `pm2 restart` (exit code 0, SIGINT), not a crash or memory-cap kill; this line originally
  speculated otherwise before that was checked. **Confirmed regardless:** `loadMoreRemote`
  swallowed every fetch failure (`!res.ok` / network catch) with no user-visible signal — a kid or
  parent had no way to tell "you truly have no chats" apart from "the request silently failed,"
  violating the project's own no-dead-end-errors rule (`CLAUDE.md` §5).
- **Fix:** `recentsError` state set on any failed/thrown `/api/chats` fetch, cleared on the next
  success; `Sidebar` renders "⚠️ Couldn't load your chats — tap to retry" in the Recent list
  (`Sidebar.tsx`) wired to `onRetryRecents` → `loadMoreRemote`.
- **Result (verified):** manually forced `/api/chats` to 500 via Playwright route interception —
  retry row renders and re-fetches on click (screenshot-verified). Full suite 676/676 green;
  `tsc --noEmit` clean. No regression test added — this is presentational wiring with no new pure
  logic branch (consistent with the repo's no-@testing-library convention).
- **Impact:** a failed history fetch is now visible and recoverable instead of reading as "your
  chats are gone." Does not fix the underlying stale-bundle-after-redeploy possibility — flagged
  as a separate follow-up, not yet actioned (the restart-cadence half of the original theory was
  ruled out the same day, see below).
- **Prevention:** class = **silent fetch failure with no user affordance**. Any other spot that
  swallows a fetch failure without surfacing a retry is the same class.
- **Related:** `TECH_DEBT.md` #20 (secret-drift preflight, checked clean this time but still
  unguarded going forward); `UAT_SSO.md` known limitations (identity split, checked clean this
  time); the stale-bundle-after-redeploy signal is unlogged/unactioned — worth its own
  KNOWN_BUGS.md row if it recurs. The restart-count part of the original theory was investigated
  later the same day and found to be deploy cadence, not a bug — see the entry above.

### 2026-07-16 — Chat history looked lost on a new browser — real, just never auto-restored

- **Symptom (what the user saw):** "i lose chat though i log into the same account. i think it is
  tied up to the browser rather to account" — opening kidgemini in a different browser while
  logged into the same real account showed a blank "New chat" greeting instead of their actual
  conversation.
- **Surface area:** `src/components/ChatPanel.container.tsx` (the mount/bootstrap effects),
  `src/lib/chat-sync.ts` (new `chatToAutoRestore`).
- **Root cause:** not data loss — chats were durably stored server-side the whole time
  (`TECH_DEBT.md` #26). But the ACTIVE/main-view conversation was hydrated ONLY from
  `localStorage` on mount; the server-history bootstrap separately loaded a paginated INDEX
  (summaries only) shown in the sidebar. On a browser with empty localStorage, `convos` stayed at
  its default blank greeting — the real history existed and was technically one click away in the
  sidebar, but nothing surfaced it as "your chat is right here," so it read as lost.
- **Fix:** `chatToAutoRestore(hadLocalChats, remoteIndex)` (`chat-sync.ts`) — a pure function
  returning the id of the newest server chat to auto-open when the device had NO local chats at
  all, or `null` when local chats already exist (a device's own in-progress chats are never
  overridden) or there's nothing server-side either. `ChatPanel.container.tsx`'s bootstrap effect
  now calls this after loading the first index page and, if it returns an id, fetches that chat's
  full messages and replaces the blank greeting with it.
- **Result (verified):** 3 new tests in `chat-sync.test.ts` (9/9 in that file) covering all three
  branches (restore-newest, never-override-local, nothing-to-restore). Full suite 671/671 green;
  `tsc --noEmit` clean.
- **Impact:** logging into the same account on a new browser/device now resumes the most recent
  conversation automatically instead of silently starting fresh; a device that already has local
  chats is never touched by this.
- **Prevention:** class = **data existed, but nothing surfaced it as present** (the console-log
  class from `BUG_LOG.md`'s protocol, applied here to a UI default rather than a network error).
  The 3 new tests pin the exact restore-vs-never-override contract.
- **Related:** `TECH_DEBT.md` #26 (server-side chat history) shipped the durable storage this
  entry's fix finally surfaces correctly on a fresh device.

### 2026-07-16 — Mic dictation repeat, take 2: same symptom, new trigger (regression of 2026-07-14)

- **Symptom (what the user saw):** dictated text repeating in the chat composer again — same shape
  as the 2026-07-14 "I want I want I want" bug, reported as "we solved this before, it's back."
- **Surface area:** `src/components/useSpeechInput.ts` (`start`, the `onend` restart timeout),
  `src/lib/speech-transcript.ts` (new `committedCountAfterRestart`).
- **Root cause:** the 2026-07-14 fix made the caller self-track `committedFinalsRef` instead of
  trusting the browser's `event.resultIndex` — but it reset that counter to 0 at every `rec.start()`
  **call**, not every *successful* start. `start()` throws `InvalidStateError` ("already started")
  when the browser hasn't actually torn down the previous recognition session yet — a documented
  Chrome timing quirk; the 200ms restart delay is best-effort, not a guarantee, and the code's own
  `catch { /* already started */ }` shows this was anticipated but never wired up. When the race
  hits, the OLD session — with its already-accumulated finals — keeps feeding `onresult`, so
  zeroing the counter anyway makes the next event replay everything already committed. Same class
  as 2026-07-14 (trusting a browser assumption without verifying it), different unverified
  assumption: "a `start()` call always yields a fresh session."
- **Fix:** `committedCountAfterRestart(startSucceeded, previousCount)` (`speech-transcript.ts`) —
  only resets to 0 when `rec.start()` did not throw; both restart sites in `useSpeechInput.ts` now
  track whether `start()` succeeded and call this instead of unconditionally zeroing.
- **Result (verified):** 3 new tests in `speech-transcript.test.ts` (16/18 total in that file) —
  including a regression test that reproduces the old always-reset behavior replaying "I want"
  and confirms the fixed decision function doesn't. Full suite 661/661 green; `tsc --noEmit` clean.
- **Impact:** dictation in both the composer and the Idea Bag mic tab no longer replays committed
  text when a restart races the browser's own session teardown.
- **Prevention:** class = **trusting an unverified browser-API assumption** (same family as
  2026-07-14). The 3 new tests pin the specific "failed start ⇒ keep old count" contract.
- **Related:** 2026-07-14 entry above (first occurrence, different mechanism, same symptom).

### 2026-07-14 — Sign-in wall mid-turn silently dropped the kid's message ("the chat died")

- **Symptom (what the user saw):** during game development, hitting the
  sign-in wall (Google-only copy, separately fixed below) felt like "the chat
  died" — after signing in and returning, the message that triggered the wall
  was gone; the kid had to retype it, making the whole detour feel much slower
  than a real retry.
- **Surface area:** `src/components/ChatPanel.container.tsx` (`runStream`'s
  401/`gate` handling), new `src/lib/pending-message.ts`.
- **Root cause (silent-drop class):** both sign-in-wall paths — the top-level
  HTTP 401 (guest already over limit) and the mid-stream `{type:"gate"}` event
  (this message's tokens pushed the guest over) — set `finalized = true`,
  which the existing `pending-turn.ts` mechanism (built for tab-close/server-
  generation recovery, keyed by `replyId`) then clears. Neither path ever
  captured the raw message text — there was nothing TO resume, since a 401
  fires before Gemini is ever called. The kid's typed message was simply gone.
- **Fix:** new `src/lib/pending-message.ts` (`savePendingMessage`/
  `loadPendingMessage`/`clearPendingMessage`, localStorage-backed so it
  survives the full-page redirect to the platform's `/login` and back, 10-min
  TTL — resuming a keystroke, not a generation). Both sign-in-wall branches in
  `runStream` now save the text (skipped when an image is attached — scoped to
  the common case). Once `useSession()` reports `authenticated`, a new effect
  in the container checks for a matching pending message (same `convoId`),
  posts a brief "Welcome back! Sending your message now…" note so the
  auto-resend is visible rather than a silent surprise, then calls
  `handleSend` with the recovered text — once per mount (ref-latched only
  after an actual match, so an early check racing `activeId`'s restore gets a
  second chance on the next change instead of giving up for good).
- **Result (verified):** `src/lib/pending-message.test.ts` (new, 9 tests):
  round-trip, TTL boundary (valid just under 10 min, expired just past),
  never-throws (quota/private mode), malformed/missing-field JSON treated as
  absent. Full suite: 573/573 passing. `tsc --noEmit` clean.
- **Impact:** a sign-in interruption mid-conversation now recovers the kid's
  message automatically instead of losing it; rate-limit and paywall
  interruptions are deliberately NOT auto-resumed (resubmitting immediately
  would just hit the same wall).
- **Prevention:** the 9 new tests pin the save/load/clear/TTL contract;
  registered in `docs/REGRESSION-TEST-CATALOG.md`. Class note: any future
  "the user must come back later to finish this" flow (payment, verification,
  another redirect) should ask whether the interrupted input needs the same
  short-TTL local recovery treatment, not just the already-established
  server-side turn-recovery one.
- **Related:** `docs/BUG-FIX-LOG.md` 2026-07-13 (`pending-turn.ts`'s tab-close
  recovery — the other half of interruption handling, for an already-running
  generation rather than a message that never got sent).

### 2026-07-14 — Unfenced game code reached the chat bubble raw — garbled text with a stray "code / Download / Copy" widget mid-content

- **Symptom (what the user saw):** in production, after asking for an
  improvement to a previewed game, the chat window showed the game's full raw
  HTML/CSS/JS as garbled plain text, with a stray "code ⬇ Download ⧉ Copy"
  toolbar rendered in the *middle* of the CSS — not one clean code block.
- **Surface area:** `src/app/api/chat/route.ts` (the `"done"` event's `text`
  field), `src/lib/gemini.ts` (`extractArtifact`), `src/components/Markdown.tsx`
  (`CodeBlock`, unchanged but implicated).
- **Root cause (rendering-contract class, not a data bug):** `route.ts` always
  sent the model's raw reply text (`full`) to the client for chat-bubble
  display ("Gemini style: full text shown in chat"). `extractArtifact` already
  tolerates the model failing to close (or ever open) a ` ```html ``` ` fence —
  it has 3 cases and correctly extracts `artifactHtml` for the preview panel in
  all 3 — but cases 2/3 (no clean fence) left `full` itself unfenced. The chat
  bubble renders `full` through `react-markdown` + `remark-gfm`
  (`Markdown.tsx`), which applies full CommonMark parsing to it. Reproduced
  directly: the reported game's CSS/JS was 4+-space indented with blank lines
  between rule groups — CommonMark treats that as one or more **indented code
  blocks** (no language), and `CodeBlock`'s `isBlock = Boolean(lang) ||
  code.includes("\n")` renders *any* multi-line `code` node with the full
  toolbar — hence the spurious "code" (generic label, no `lang`) widget
  scattered wherever CommonMark started a new indented chunk. Production logs
  (`pm2 logs kidgemini`) confirm this instance runs frequent
  `died mid-answer — restarting fresh on the next model` fallbacks and at
  least one hedge race — exactly the kind of turn where a long "improve this
  game" generation can end without a closed fence.
- **Fix:** `extractArtifact` (`src/lib/gemini.ts`) now returns a `wasFenced`
  flag alongside `text`/`artifactHtml`, so the caller knows whether the
  original reply already had one clean, closed fence (case 1) versus a
  fallback (cases 2/3). `route.ts` builds a `displayText`: when
  `artifactHtml` is present and `wasFenced` is falsy, it re-fences the
  artifact (`prose + "\n\n```html\n" + artifactHtml + "\n```"`) before sending
  it as the `"done"` event's `text` and before persisting it via
  `turnResults.complete`; the already-working case (a clean fence, including
  any trailing prose after it) is untouched byte-for-byte. `recordUsage(...,
  full, ...)` still meters the true raw `full` — billing is unaffected
  (BUG-FIX-LOG 2026-07-13's "meter the FULL reply" contract holds).
- **Result (verified):** `src/lib/gemini.extract-artifact.test.ts` (new, 4
  tests) pins `wasFenced` for all 3 extraction cases + the no-artifact case.
  `src/app/api/chat/route.test.ts` gained 3 tests (F.1-F.3): F.1 confirms an
  unfenced reply is re-fenced before reaching the client; F.2 confirms a
  cleanly-fenced reply (with trailing prose) is sent unchanged; F.3 re-parses
  both the raw text and the fixed `displayText` with the actual
  `remark-parse`/`remark-gfm` stack `Markdown.tsx` uses and asserts the raw
  text produces a language-less "stray" code node (the historical bug shape)
  while the fixed text produces exactly one `html`-tagged code node. All 3 new
  route tests fail against the pre-fix code (confirmed) and pass after. Full
  suite: 558/558 passing. `tsc --noEmit` clean.
- **Impact:** every chat reply that builds/edits a game now always displays as
  one clean, collapsible code card, regardless of whether the model's fence
  was well-formed, truncated, or missing — no user-visible or behavior change
  for the already-working case.
- **Prevention:** the class is "a fallback-tolerant extractor's fallback path
  wasn't propagated to every consumer that assumed the strict/common case" —
  the 4 new `extractArtifact` tests plus the 3 new route tests pin this;
  registered in `docs/REGRESSION-TEST-CATALOG.md`. Future callers of
  `extractArtifact` that display `text` as markdown must check `wasFenced`
  before doing so.
- **Related:** 2026-07-13 (mid-answer model restart mechanic — the same
  instability that produces truncated fences); 2026-07-13 (usage metering
  "meter the FULL reply" — this fix does not touch that contract).

### 2026-07-14 — 3D model catalog doubled 50→100; publish gate caught 2 real gaps (owner request: city models, race tracks, dragons)

- **Symptom:** `node scripts/vendor-models.mjs --upload` uploaded and verified
  all 50 new models on the live CDN (assets.ariantra.com) and wrote all 100
  manifest entries — then the contract-test gate (stage 5) failed twice and
  the script exited non-zero, leaving the working tree in a "assets are live,
  local repo doesn't pass its own tests yet" state.
- **Surface area:** `scripts/vendor-models.mjs` (50 new curated entries: city
  models from two new kits — city-kit-commercial, city-kit-suburban — plus
  racing-kit for track pieces, plus two Quaternius dragons via poly.pizza);
  `src/lib/assets/gallery.ts` (emoji map); `src/lib/assets/model-select.ts`
  (GENRES); `src/lib/assets/prompt-catalog.test.ts` (sanity ceiling).
- **Root cause (two independent gate failures, both by design — not bugs in
  the gate):**
  1. `gallery.test.ts`'s emoji-lockstep test: every curated model needs its
     own gallery-card emoji or it silently falls back to 🧸. The 50 new names
     had no entries in `gallery.ts`'s `EMOJI` map — first failure was
     `garbage_truck`, but all 50 were missing.
  2. `prompt-catalog.test.ts`'s sanity ceiling: manifest models must stay
     ≤ 60, "revisit selection priorities at the next doubling" — by design,
     since the catalog exactly doubled (50→100), this is that doubling.
- **Fix:**
  1. Added all 50 emoji to `gallery.ts` (e.g. `dragon: "🐉"`, `pizza: "🍕"`,
     `race_track_straight: "🛣️"`).
  2. Actually revisited selection priorities (not just bumped the number):
     extended `model-select.ts`'s `GENRES` so every new model routes through
     a genre trigger — race-track pieces + go-kart/pickup/garbage truck join
     "racing / driving"; siege weapons + both dragons join "castle /
     adventure" (whose trigger already matched `dragons?`, but the model list
     didn't carry any dragon names until now); city buildings join "city";
     the 15 new food items join "food / cooking"; nature props join "forest
     / nature". Bumped the ceiling 60 → 120 in `prompt-catalog.test.ts`, with
     a comment pointing at this entry so the "was it revisited?" question is
     answerable at the next doubling.
- **Two dragons sourced, one swapped mid-build:** the first "Dragon Evolved"
  candidate (poly.pizza/m/LlwD0QNUPj) came in at 119 KB even after
  `simplify(0.5)` — confirmed `simplify()` no-ops on this project's
  skinned/rigged meshes (same class as the Shiba Inu/Husky/horse rejections
  in `vendor-models.mjs`'s curation comments), and animation trimming barely
  moved the size either (mesh-dominated, not clip-dominated). Swapped to a
  second Quaternius dragon (poly.pizza/m/3rUm1cN3yp, smaller mesh, same
  animation set) — fits fully un-simplified at 74 KB.
- **Result (verified):** `npx vitest run src/lib/assets/` — 8 files, 112/112
  passing. `node scripts/assets-contract-check.mjs` — all 100 models 200,
  immutable, CORS, hash-match on the live CDN. `tsc --noEmit` clean on every
  changed file.
- **Impact:** 100 CC0 3D models now live in the kid-facing catalog and
  correctly wired into retrieval-lite prompt selection; every model has a
  gallery emoji; no change to per-prompt token cost (`PROMPT_MODEL_CAP`
  stays 30 — this was a catalog-size ceiling, not a per-prompt one).
- **Prevention:** both gates already existed and did their job — this entry
  is the record that they were addressed, not routed around. Next doubling
  (~200 models) should get the same treatment: emoji for every new name,
  genre wiring (not just name-literal fallback matching), ceiling bump with
  a dated comment.
- **Related:** 2026-07-13 (retrieval-lite selection built, PROMPT_MODEL_CAP
  raised 25→30); 2026-07-12 (Phase F fill-out to 20 models, same curation
  discipline — reject over-budget rigged models rather than force-fit them).

### 2026-07-14 — Mic dictation repeated words 3x on a short phrase, 30-40x on a long one

- **Symptom (what the user saw):** speaking "I want" into the mic (Composer
  and the preview-pane Idea Button both affected) produced "I want I want I
  want" in the text box; longer monologues repeated words up to 30-40x, with
  earlier words repeating the most.
- **Surface area:** `src/lib/speech-transcript.ts` (`splitSpeechResults`),
  `src/components/useSpeechInput.ts` (`onresult`, `start`, the `onend`
  auto-restart) — shared by both mic surfaces (`Composer.tsx`,
  `IdeaMicTab.tsx`), which is why the user saw it in both the chat box and the
  preview pane.
- **Root cause — count-mismatch class:** `onresult` sliced "what's new" by
  the browser's own `event.resultIndex`. That field is a browser *claim*
  about which results changed since the last event; on some browsers/
  webviews it doesn't reliably advance. When it stayed at (or returned to) a
  low value, every newly-finalized segment made `freshFinalText` recompute
  from the START of the session's finals instead of just the new one, and the
  caller re-appended that growing blob into the text box on every final —
  each additional final segment compounded the repeat (matches both the
  short-phrase 3x and the long-monologue 30-40x reports: the count tracks how
  many final segments the session produced). The code trusted a value it
  never verified, the same class already called out in `CLAUDE.md` §9.2
  ("count mismatch").
- **Fix:** stopped trusting `event.resultIndex` entirely. `splitSpeechResults`
  now takes `alreadyCommitted` (a count) instead of a browser-supplied index,
  slices the FINALS-only array by that count, and returns `finalCount` so the
  caller can self-track. `useSpeechInput` added `committedFinalsRef`, updated
  from `finalCount` on every `onresult`, and reset to 0 at every fresh
  `rec.start()` (both the explicit `start()` and the silent `onend`
  auto-restart) — a new session gets a fresh browser results list, so our own
  counter must reset in step.
- **Result (verified):** `speech-transcript.test.ts` — 2 new regression tests
  reproduce the exact bug shape (a browser whose resultIndex never advances,
  across both a growing session and repeated identical events) and FAIL
  against the pre-fix code (confirmed via `git stash` — old code produced
  `["I want", "I want", "I want"]` on the repeated-event test) and PASS
  against the fix. Full file: 18/18 passing. `tsc --noEmit` clean for both
  changed files.
- **Impact:** both mic entry points (main composer, preview-pane Idea Button)
  now emit each spoken word/phrase exactly once, regardless of how a given
  browser reports `resultIndex`. No API or data-shape change.
- **Prevention:** the 2 new regression tests in `speech-transcript.test.ts`
  pin this; registered in `docs/REGRESSION-TEST-CATALOG.md`. Class note for
  future browser-API integrations: never slice/dedupe by a value the API
  hands you without a fallback — self-track state you can verify instead.
- **Related:** 2026-07-10 (interim-flush entry, same file/hook, established
  the `splitSpeechResults` pure-function split this fix builds on); `CLAUDE.md`
  §9.2 count-mismatch class.

### 2026-07-13 — Usage metering excluded the game code — ~75x output undercount

- **Symptom (what the user saw):** Google AI Studio showed ~550–600k output
  tokens/day (₹300/day) while `usage_events` recorded ~4k/day — the app's
  own metering said usage was negligible during a genuinely expensive spike.
- **Surface area:** `src/app/api/chat/route.ts` (`recordUsage` call);
  every historical `outputTokens`/`outputText` row.
- **Root cause:** the route recorded `cleaned` — the reply with the ```html
  code block STRIPPED for display — instead of `full`. A build turn's game
  code is 90%+ of its billed output, so the dominant cost driver was
  invisible to the dashboard AND to the guest token gate. Compounding
  factors (still open, see Prevention): system prompt + history + thinking
  tokens are not estimated, and failed/abandoned streams record nothing.
- **Fix:** meter `full` (what Google actually bills for the reply).
- **Result (verified):** route test M.1 — a 4KB game reply records its full
  text, not the stripped ~4 tokens. Suite 514/514.
- **Impact:** future dashboards and the guest 10K-token trial now count real
  output (guests burn their trial ~faster — that is the correct behavior).
  Historical rows remain undercounted — audit past spend in the Google
  console, not the local table.
- **Prevention:** M.1 pins full-output metering. Follow-up worth building:
  record Gemini's exact `usageMetadata` (prompt/output/thinking counts,
  including failed attempts) instead of chars÷4 estimates — then the
  dashboard matches the invoice by construction.
- **Related:** companion entry below ($0 pricing for unlisted models, same
  investigation); success-rate dips in AI Studio line up with the 07-11/07-13
  503 incidents — the failed-attempt cost those days is fixed by the
  resume/hedge/restart work (this date, FEATURES.md).

### 2026-07-13 — Cost dashboard silently reported $0 for the primary model

- **Symptom (what the user saw):** 3 days of heavy real Gemini billing while
  the recorded `costUsd` for every call was 0 — the spend was invisible in
  admin/usage until the Google invoice arrived.
- **Surface area:** `src/lib/pricing.config.ts` (`MODEL_PRICING`,
  `estimateCostUsd`), every `usage_events.costUsd` row written since the
  primary moved to `gemini-3.5-flash`.
- **Root cause:** `MODEL_PRICING` only listed the 2.5-flash models; the
  primary (`gemini-3.5-flash`) and first fallback (`gemini-3-flash-preview`)
  were never added when the chain changed, and `estimateCostUsd` returned
  **0 for unknown models** — a fail-open default that hid the miss. Class:
  **silent-zero default masking real spend** (cousin of fail-open safety).
- **Fix:** all four chain models priced; unknown models now estimate at the
  flash-tier fallback rate instead of $0 (over-estimates surface and get
  corrected; zeros hide).
- **Result (verified):** `pricing.config.test.ts` — chain-coverage test fails
  before the fix, passes after; unknown model > $0. Suite 513/513.
- **Impact:** cost dashboards work again going forward. Historical rows keep
  their baked-in $0 — analyze past spend by TOKENS, not the usd column.
- **Prevention:** the chain-coverage test pins that every model in the
  fallback ladder has a price; changing `GEMINI_CHAT_MODEL` or the chain
  without pricing it now fails CI.
- **Related:** PRD-MODEL-FALLBACK (the chain change that introduced the
  unpriced models).

### 2026-07-13 — Chats beyond the 20th silently vanished from Recents

- **Symptom (what the user saw):** once a kid had more than 20 conversations,
  older ones disappeared from the sidebar's Recents with no way to reach
  them — they weren't hidden, they were gone.
- **Surface area:** `src/lib/chat-store.ts` (`saveChats`); sidebar was
  innocent (it already renders an unbounded, scrollable list).
- **Root cause:** `saveChats` hard-truncated to `MAX_CONVOS = 20` on every
  write — a quota safety margin implemented as silent data deletion. Class:
  **resource guard that destroys data instead of degrading**.
- **Fix:** cap removed. Every conversation persists; only a REAL localStorage
  quota refusal trims, oldest-first (list is newest-first, trim the tail),
  halving per retry, and the active conversation is always kept.
- **Result (verified):** `chat-store.test.ts` — 40 convos round-trip intact;
  simulated 1MB quota trims the tail but keeps the head; an active convo at
  the tail survives trimming. Suite 472/472 green.
- **Impact:** kids keep every chat until the browser genuinely runs out of
  room (game-heavy chats ~200KB can still hit the ~5MB quota at ~25 chats —
  the durable fix is server-side history, TECH_DEBT #26).
- **Prevention:** the "persists EVERY conversation" test pins the no-cap
  contract; the quota tests pin graceful oldest-first degradation.
- **Related:** TECH_DEBT #25 (rename/delete), #26 (server-side history —
  the real ceiling fix), BUG-FIX-LOG 2026-07-07 (chats lost on navigation).

### 2026-07-13 — Mid-ANSWER model death ended the turn instead of walking the chain

- **Symptom (what the user saw):** prod log 07:41–07:42: primary died
  mid-thinking → chain correctly fell back to `gemini-3-flash-preview` → that
  model started streaming the game code, then Google 503'd it mid-answer →
  "Oops! Something went wrong." with 3 unused fallbacks remaining.
- **Surface area:** `src/lib/gemini.ts` (replyStream), `src/app/api/chat/route.ts`,
  `src/components/ChatPanel.container.tsx`, `src/types/chat.types.ts` (StreamChunk).
- **Root cause:** deliberate guard — once visible answer text streamed, a
  mid-stream death surfaced instead of falling back (restarting silently would
  stitch two different answers). Correct instinct, wrong remedy: the partial
  code is meaningless to the kid (owner decision 2026-07-13 — it's a "system
  is working" signal), so ending the turn threw away 3 working fallbacks.
- **Fix:** mid-answer transient deaths now keep walking the chain; a new
  `restart` stream chunk is emitted immediately before the next model's first
  output. The route resets its accumulator (done/usage never carry wiped
  text) and relays `{type:"restart"}`; the client wipes the chat bubble ALONE
  (resets acc/reply/thinking line and the first-token stall budget — preview
  and other UI untouched) and relays the fresh thoughts + code. Real defects
  (4xx/safety) still throw immediately.
- **Result (verified):** `gemini.fallback.test.ts` F.7 (rewritten to the new
  contract), F.8 (defect still surfaces), F.9 (consecutive restarts);
  `route.test.ts` R.1 (accumulator reset). Suite 470/470 green.
- **Impact:** a kid's game-build turn now survives Google killing the stream
  at ANY phase — open, thinking, or mid-answer — as long as one chain model
  can finish. The kid sees the partial vanish and a fresh answer stream in.
- **Prevention:** F.7/F.9 pin the restart contract; R.1 pins the wiped
  accumulator. Class: **resilience guard scoped wider than the invariant it
  protects** (the invariant was "never stitch two answers", not "never retry").
- **Related:** companion entry below (transient taxonomy, same date);
  2026-07-11 (503 fallback chain); PRD-MODEL-FALLBACK §3.4.

### 2026-07-13 — Non-503 transient errors skipped the fallback chain → kid saw "Oops"

- **Symptom (what the user saw):** production chat replied "Oops! Something
  went wrong. Let's try again." even though the 4-model fallback chain
  (PRD-MODEL-FALLBACK) exists precisely to absorb Gemini incidents.
- **Surface area:** `src/lib/model-fallback.ts` (`shouldTryNextModel`),
  consumed by `gemini.ts` `replyStream`; `/api/chat` error path.
- **Root cause:** the chain's move-down predicate only matched capacity
  refusals (503/UNAVAILABLE/429) and retired models (404). Google transient
  failures that surface as **500 INTERNAL / 502 / 504** or as network-level
  drops (`fetch failed`, `ECONNRESET`, `socket hang up`, `terminated`) fell
  into the "real defect" bucket and threw straight to the Oops line — even
  though the RETRY layer (`retry.ts isRetryable`) already classified
  500/502/504 as transient. The two layers disagreed on what "transient"
  means. Class: **split-brain error taxonomy across resilience layers**.
- **Fix:** added `isTransient()` to `model-fallback.ts` (5xx INTERNAL +
  network drop signatures, aligned with `retry.ts`) and included it in
  `shouldTryNextModel`. Safety/auth/400s still throw immediately.
- **Result (verified):** `model-fallback.test.ts` — 3 new tests fail before
  the fix, pass after; full suite 467/467 green.
- **Impact:** any Google 5xx or connection drop now walks the fallback chain
  (primary keeps its retries, each fallback gets one attempt) instead of
  ending the kid's turn. Mid-stream failures after visible answer text still
  surface, by design.
- **Prevention:** regression tests pin 500/502/504 + network shapes as
  chain-walking; the "stays out of caller-defect messages" test pins the
  fail-closed side. When touching either error taxonomy, keep `retry.ts
  isRetryable` and `model-fallback.ts isTransient` in agreement.
- **Related:** PRD-MODEL-FALLBACK §3 (chain policy); 2026-07-11 incident
  entry (503 mid-thinking fallback).

### 2026-07-12 — Model pipeline shipped white (textureless) Kenney models to the asset host

- **Symptom (what the user saw):** in the gallery's first populated visual
  pass, car/tree/coin turntables rendered as untextured white geometry;
  console showed `THREE.GLTFLoader: Couldn't load texture
  data:image/png;base64,ERR/`. Three broken GLBs were already uploaded and
  verified (hash/headers were fine — the bytes were wrong at birth).
- **Surface area:** `scripts/vendor-models.mjs`; the objects
  `car.193376.glb`, `tree.61c4aa.glb`, `coin.87b951.glb` on the asset host
  (now permanently unreferenced — append-only host, no delete).
- **Root cause:** two stacked failures. (1) Kenney GLBs reference an
  EXTERNAL `Textures/colormap.png` sitting beside them in the kit zip; the
  pipeline extracted only the .glb, so the texture could never resolve.
  (2) gltfpack's npm WASM build then embedded the unresolvable texture as a
  literal `data:image/png;base64,ERR/` **instead of failing** — the
  contract's sha/size/magic checks all passed because the file was
  perfectly valid GLB carrying a broken texture. Class: **content-level
  correctness is invisible to byte-level verification** — only a render
  (visual pass / gallery dogfood) catches it.
- **Fix:** pipeline extracts the kit's `Textures/` folder next to each GLB
  and compresses with gltf-transform + meshoptimizer (`dedup → prune →
  resample → meshopt high`), which resolves and EMBEDS the texture and
  hard-fails on unresolvable resources (that error is what exposed the
  truth). gltfpack devDependency removed. Animated dino trims to the three
  clips a kid game uses (Run/Idle/Attack) to hold the 100 KB budget.
- **Result (verified):** real-Chromium harness screenshot shows the car
  fully textured and the dino animated (3 clips); all five models rebuilt
  under budget (33/89/21/15/16 KB); verify verdict clean, zero console
  errors.
- **Impact:** no kid game ever referenced the broken files (caught before
  UAT); the three orphaned objects stay on the host unreferenced, as the
  append-only contract intends. Re-upload republishes under new hashes.
- **Prevention:** the gallery IS the standing content-level smoke check
  (PRD §9b — "if the gallery renders, the host works"); pipeline now
  fails loudly on unresolvable resources instead of embedding garbage.
- **Related:** PRD-3D-GAMES-AND-ASSETS §4.3/§9b; Phase C progress note.

### 2026-07-12 — 100dvh mobile-sizing rule silently lost in the Phase-0 revert (regression rediscovered)

- **Symptom (what the user saw):** none reported yet — caught in code review
  while re-introducing 3D (Phase B): `CHILD_SYSTEM_PROMPT` was back to
  `height:100%` with no dvh guidance, so newly generated games could again
  pin on-screen buttons under a mobile browser's address bar when opened by
  their own link (the exact 2026-07-08 bug).
- **Surface area:** `src/lib/gemini.ts` (`CHILD_SYSTEM_PROMPT`).
- **Root cause:** the 100dvh fix (BUG-FIX-LOG 2026-07-08) shipped inside the
  same commit as the Three.js Phase-0 work (`aa2cd33`); reverting Phase 0
  (`cf391d5`) took the unrelated bug fix down with it. Its regression test
  lived in the also-reverted `gemini.test.ts`, so nothing failed. Class:
  **a revert of a feature commit silently reverts the bug fixes riding in
  it** — a fix sharing a commit with a revertable feature loses its
  guardrail exactly when the guardrail is needed.
- **Fix:** restored the 100dvh (NEVER 100vh) rule + the
  `env(safe-area-inset-bottom)` breathing-room bullet in
  `CHILD_SYSTEM_PROMPT` (`src/lib/gemini.ts`).
- **Result (verified):** `src/lib/assets/prompt-catalog.test.ts`
  ("100dvh mobile sizing" describe) pins both rules; full suite green
  (392/392).
- **Impact:** newly generated games size correctly on mobile again. Games
  generated between the revert (2026-07-08) and today may still carry 100vh
  in the preview, but the platform's publish-time `viewport-height-fix.ts`
  (platform BUG_LOG #9) keeps published bundles corrected — exposure was
  preview-only.
- **Prevention:** the prompt pins now live in `prompt-catalog.test.ts`,
  independent of any feature module; when reverting a feature commit, check
  its BUG-FIX-LOG entries for unrelated fixes riding along.
- **Related:** 2026-07-08 100dvh entry; commits `aa2cd33`, `cf391d5`.

### 2026-07-12 — Asset-host CORS was conditional; a policy-propagation race poisoned the browser cache for a year

- **Symptom (what the user saw):** the Phase A canary game
  (`canary-3d.ariantra.com`) showed *FAIL — Failed to fetch dynamically
  imported module: https://assets.ariantra.com/three.b4a9d4.js* on every
  reload, while `npm run assets:check` was fully green.
- **Surface area:** asset host serving config (CloudFront response headers
  policy on the `*.ariantra.com` wildcard); `scripts/assets-contract-check.mjs`.
- **Root cause:** the managed `SimpleCORS` response-headers policy emits
  `Access-Control-Allow-Origin: *` **only when the request carries an
  `Origin` header**. The first canary visit raced the policy's propagation:
  the browser's module fetch received a header-less response and cached it
  under `Cache-Control: max-age=31536000, immutable` (and pre-policy
  responses carried no `Vary: Origin`), so every later load replayed the
  poisoned entry without revalidating — a permanent client-side CORS failure.
  The smoke check passed because it always sent an `Origin` header, so it
  could never see the variant browsers can cache.
- **Fix:** (1) infra — dropped the response headers policy entirely and added
  a **CloudFront Function on viewer-response** (`ariantra-unconditional-cors`,
  alongside the existing `ariantra-host-rewrite` on viewer-request) that
  assigns `Access-Control-Allow-Origin: *` on EVERY response. (CloudFront
  refuses CORS headers in a policy's custom-headers section, so a function is
  the only unconditional mechanism; public CC0 files, PRD §10.4 amended.)
  (2) `scripts/assets-contract-check.mjs` — each asset is now fetched a second
  time WITHOUT an `Origin` header and the check fails if the CORS header is
  absent, making conditional CORS a standing contract failure.
- **Result (verified):** no-Origin `curl -I` on the engine URL shows
  `access-control-allow-origin: *`; `npm run assets:check` green including
  the new check; canary badge **PASS in a real headless Chromium** (the same
  probe that reproduced the failure), QUIC on and off. A second real finding
  from the same investigation: one HYD57 edge node served pre-policy config
  long after the console said deployed — real-browser probing caught what
  curl sampling could not.
- **Impact:** only pre-fix visitors of the canary hold a poisoned cache entry
  (one hard-reload clears it); no kid game referenced any asset yet — this is
  exactly the failure class Phase A's canary gate exists to catch before
  there are real dependents.
- **Prevention:** the no-Origin smoke check (standing, runs post-deploy via
  `deploy-rsync.sh`). **Class: conditional response headers on immutable,
  forever-cached objects — any variance must be treated as a contract
  violation, not a config nuance.**
- **Related:** PRD-3D-GAMES-AND-ASSETS §10.2/§10.4/§12 Phase A; platform
  BUG_LOG #6 (explicit cache policy) and #9 (standing `curl -I` smoke).

### 2026-07-12 — Idea Button coach auto voice-over intrusive/low-quality — made silent, voice on request

- **Symptom (what the user saw):** on the first game preview, the Idea Button
  coach auto-played a robotic browser-TTS voice-over ("Hi! I'm your Idea
  Button!…") with no way to opt in — owner UAT'd it as "very bad": startling
  and low quality (default `speechSynthesis` voice, no voice selection).
- **Surface area:** `src/components/IdeaMicTab.tsx` (coach overlay),
  `src/lib/idea-coach.ts` (comments), `scripts/e2e-idea-coach.mjs`,
  `docs/PRD-IDEA-BUTTON.md` §3b/§5/§6.
- **Root cause:** design decision, not code defect — the PRD made voice the
  onboarding ("voice IS the onboarding") and auto-spoke `COACH_LINE` in a
  `useEffect` on first coach show. Default browser TTS quality made the
  auto-play net-negative UX.
- **Fix:** removed the auto-speak effect (`IdeaMicTab.tsx` coach section);
  the silent bubble + demo animation are now the onboarding. Added a
  **🔊 Hear it** button beside "OK, got it!" that speaks `COACH_LINE` on tap
  and toggles to **⏹ Stop** while speaking (mirrors `MessageItem.tsx`
  `ReadAloudControls`). Every dismissal path still cancels in-flight speech.
- **Result (verified):** `scripts/e2e-idea-coach.mjs` — new pins: fresh
  device shows the coach with `__spoken` empty; Hear it pushes the line;
  Stop state visible while speaking; OK-during-speech increments `__cancels`;
  reduced-motion stays silent with Hear it working. All prior pins
  (dismissal persistence, tab-tap→listening, re-nudge-once) green.
- **Impact:** first-run onboarding is quiet by default; pre-readers still get
  the line read aloud, now on demand. Coach policy/storage unchanged.
- **Prevention:** class = *auto-playing audio without user gesture*. The e2e
  script now pins "no speech before a user tap" — any future auto-speak on
  coach show fails scenario A/J.
- **Related:** PRD-IDEA-BUTTON.md §3b (coach added 2026-07-12, same day).

### 2026-07-11 — PROD: "Oops! Something went wrong." during Gemini 503 spikes — no model fallback

- **Symptom (what the user saw):** in production, chats died with "Oops!
  Something went wrong. Let's try again." — including popping into a chat the
  parent was just reading (an in-flight request failing behind the scenes).
  pm2 error log: repeated `gemini.chat.stream` retries then
  `503 UNAVAILABLE "This model is currently experiencing high demand"`.
- **Surface area:** `src/lib/gemini.ts` (`replyStream`), `.env.example`.
- **Root cause:** Google-side capacity refusal on the primary model
  (`gemini-3.5-flash` in prod). Our only resilience was `withRetry` ×2 against
  the SAME overloaded pool — 503 spikes last hours, so retries just re-failed
  and the route sent the generic error event.
- **Fix:** overload-aware model fallback CHAIN (4 deep, owner decision same
  day): when the stream fails to OPEN with a capacity error (503/UNAVAILABLE/
  "high demand"/429) or a retired model id (404), walk `GEMINI_FALLBACK_MODELS`
  (owner chain: 3-flash-preview → 2.5-flash → 2.5-flash-lite), one attempt
  per fallback. Non-capacity errors throw immediately — no wasted call, and a
  mid-chain real defect stops the walk. Same-day follow-up from live logs: the
  incident's dominant shape was accepted-then-503-while-THINKING (@433s) — the
  chain now also restarts on the next model when a stream dies BEFORE any
  answer text (after answer text, the client auto-retry owns it — never
  duplicate visible output). Policy in `src/lib/model-fallback.ts`.
- **Result (verified):** `gemini.fallback.test.ts` F.1–F.7 +
  `model-fallback.test.ts` (fail on the old code); suite 283 green; typecheck
  clean.
- **Impact:** during Gemini capacity spikes kids get a slightly-less-fancy
  game instead of an error; error events now mean something is actually wrong.
- **Prevention:** class = **single-provider-pool retry** (retrying into the
  same overloaded resource). Any new model call site must route through a
  fallback-aware opener or document why not.
- **Related:** 503 incident 2026-07-11 (pm2 logs); builder-mode thinking
  changes same day (docs/FEATURES.md).

### 2026-07-11 — Updated game never reached the preview: verify rounds collide across games

- **Symptom (what the user saw):** ask for a change to an existing game →
  "Testing your game…" sat on the pane until the hard timeout, then the OLD
  game was still there. The new version never showed up in the preview
  (chat said it was done).
- **Surface area:** `src/components/ArtifactFrame.tsx` (srcDoc memo + iframe
  key), `src/components/usePreviewVerify.ts`, `src/lib/preview-pane.ts`.
- **Root cause:** the srcDoc `useMemo` and the iframe `key` were pinned to
  `state.round` alone. `round` restarts with every `PreviewVerifyController`
  instance (one per game html), but the hook's React state persists across
  instances — so when game v1 finished at round 1 (clean, no probe-click
  reload) and v2's controller also began at round 1, the deps never changed:
  the iframe kept v1's document, the probes had nothing instrumented to
  report, and the cover hung until `ROUND_HARD_TIMEOUT`. Swaps only ever
  worked when v1 happened to end on a bumped round (probe click / repair) —
  an accidental parity condition.
- **Fix:** doc identity is now `previewDocKey(generation, round)`
  (`src/lib/preview-pane.ts`) — the hook bumps a generation counter per game
  html (`usePreviewVerify.ts`), and `ArtifactFrame` keys both the srcDoc memo
  and the iframe on the composite.
- **Result (verified):** `scripts/e2e-preview-pane.mjs` (real browser, mocked
  `/api/chat`): before — iframe srcdoc stayed `GameV1` forever after `done`;
  after — `GameV2` swaps in ≤1s after `done`, verify runs, uncovers v2.
  `preview-pane.test.ts` pins the key invariant.
- **Impact:** every kid iterating on a game — the core loop. Updates now
  reliably appear in the preview.
- **Prevention:** class = **stale-memo/key collision across resetting
  counters** (sibling of the closure-stale-state class). Pins:
  `src/lib/preview-pane.test.ts` (`previewDocKey`) + e2e script check
  "new game reached the iframe".
- **Related:** PRD-SELF-HEALING-PREVIEW §8; same-day entry below (verify
  restart on `originalRequest`); docs/PRD-PREVIEW-PANE.md.

### 2026-07-11 — Sending a new ask re-covered (and re-verified) the unchanged old game

- **Symptom (what the user saw):** the moment a kid asked for a new feature,
  the still-open previous game vanished behind "Testing your game…" for the
  whole generation — instead of staying playable.
- **Surface area:** `src/components/usePreviewVerify.ts`.
- **Root cause:** the controller effect's deps were `[html, originalRequest]`.
  `originalRequest` is the latest child message, so a new ask disposed the
  controller and started a full verify pass (cover + probes, potentially a
  Gemini repair call) on html that hadn't changed.
- **Fix:** effect deps are `[html]` only; `originalRequest` rides in a ref and
  is read when html changes — so a repair prompt still carries the ask that
  produced that html (`usePreviewVerify.ts`).
- **Result (verified):** e2e checks "old game still in iframe" + "no verify
  cover over old game" mid-generation, with the new "Making your update…"
  strip visible.
- **Impact:** kids keep playing the old game during every update; no wasted
  verify/repair passes (repair calls cost a Gemini request each).
- **Prevention:** class = **effect over-triggering on a rode-along dep**.
  Pin: `scripts/e2e-preview-pane.mjs` "old game during update" section.
- **Related:** entry above (round collision); docs/PRD-PREVIEW-PANE.md.

### 2026-07-11 — Publish kept re-asking the PIN: platform's 403 masqueraded as parent_required

- **Symptom (what the user saw):** "Ask a grown-up 🧑‍🚀 … A grown-up needs to
  say OK" reappeared after every correct PIN — silently, no error text —
  when publishing locally.
- **Surface area:** `src/app/api/arcade/publish/route.ts` (+ `.env.example`).
- **Root cause (two layers):** locally `ARIANTRA_API_BASE` was unset (and
  undocumented), so the publish bridge defaulted to PRODUCTION
  `studio.ariantra.com` with the local dev `AUTH_JWT_SECRET` as
  `x-admin-secret`. The platform partner endpoint 403s on a secret mismatch —
  and our route forwarded that status verbatim, where the UI treats ANY 403
  as `parent_required` (PublishToArcade routes 403 → PIN step, silently).
  Correct PIN → publish → prod 403 → PIN step, forever. The PIN/cookie were
  fine; the misconfig was invisible.
- **Fix:** `partner()` maps an upstream 403 (which can ONLY mean operator
  misconfig — secret drift or wrong ARIANTRA_API_BASE) to **502** with an
  actionable message, so it can never collide with our own 403
  parent_required. `ARIANTRA_API_BASE` documented in `.env.example` with the
  local-dev value (`http://localhost:3000`).
- **Result (verified):** G.3c (gates pass + partner 403 → 502, error ≠
  parent_required; fails on the old code); suite 245 green; typecheck clean.
- **Impact:** local publish now fails LOUDLY with "check the setup" until
  ARIANTRA_API_BASE is set — and works end-to-end once it is. Prod behavior
  unchanged (secrets match there; 403 never occurs on a healthy box).
- **Prevention:** class = "upstream status forwarded verbatim collides with a
  local gate's status contract". Any proxied status that the client interprets
  specially (401/403/409 here) must be either owned by this route or remapped.
- **Related:** parent-cookie Secure bug (same date, below); platform
  BUG_LOG #12; PRD-PARENT-AUTH-ALERT-SCOPING §8.

### 2026-07-11 — PIN accepted but the gate re-prompted forever (parent cookie dropped on http)

- **Symptom (what the user saw):** "after parent's PIN it again comes back to
  parent's PIN — not moving beyond" (local dev). Entering the correct PIN
  returned 200 with a parent-session cookie, then the very next request
  behaved as if no PIN had ever been entered.
- **Surface area:** `src/app/api/parent/verify-pin/route.ts`,
  `src/app/api/parent/pin/route.ts`, `src/lib/parent-session.ts`.
- **Root cause:** both PIN routes hardcoded `secure: true` on the
  `kidgemini_parent` cookie. On `http://localhost:3001` the browser (Safari
  always; per spec any non-secure context) refuses to STORE a Secure cookie —
  so the mint succeeded, the Set-Cookie header went out, and the cookie
  silently never existed. Every gate check (`getVerifiedParentAccount`) then
  found nothing and re-prompted. The platform's SSO cookie already made
  Secure configurable; the parent cookie didn't follow the convention.
- **Fix:** new pure `parentSessionCookieAttrs(isProd = NODE_ENV==="production")`
  in `parent-session.ts`, used by BOTH issuing routes — Secure in production
  (unchanged), plain in dev; HttpOnly/SameSite=Strict/TTL identical either way.
- **Result (verified):** parent-session.test.ts attrs case (prod true / dev
  false, non-Secure attrs unweakened) + no-Secure assertions in both route
  tests (fail on the old code); suite 244 green; typecheck clean.
- **Impact:** local PIN flow completes — verify once, gate stays open for the
  30-min parent session; production cookie flags unchanged.
- **Prevention:** class = "cookie flags hardcoded for prod break every
  non-https environment". Cookie attributes now live in ONE tested helper per
  cookie; new cookies must define attrs the same way (see the platform's
  `session-cookie.ts` as the sibling convention).
- **Related:** platform BUG_LOG #12 (same local-testing sweep);
  PRD-PARENT-AUTH-ALERT-SCOPING §8.

### 2026-07-10 — "Sign in again" never cleared the stale-session error on PIN set

- **Symptom (what the user saw):** setting the parent PIN kept showing "For
  safety, sign in again first — then come straight back here" even after
  clicking Sign in again and logging in.
- **Surface area:** `src/app/parent/page.tsx`, `src/lib/useAriantraSession.tsx`
  (kidgemini) + platform `src/lib/auth/arrival.ts`, `src/app/studio/page.tsx`.
- **Root cause:** design collision with the BUG_LOG #10 SSO fix. The PIN
  set/reset gate requires a session JWT with `iat` ≤ 5 min — but the platform
  login page, on seeing a still-valid shared cookie, bounces straight back
  WITHOUT re-authenticating (that bounce was itself the fix for the
  kidgemini↔Studio login loop). "Sign in again" round-tripped in ~1s with the
  SAME old cookie; the iat never refreshed; the gate refused forever.
- **Fix:** `signIn({ reauth: true })` appends `reauth=1`;
  `resolveStudioArrival` (pure, tested) never bounces when `reauth` is set —
  it force-logs-out Studio (clearing the shared cookie, so abandoning re-auth
  fails CLOSED) or stays on the login form; a real login re-mints a
  fresh-iat cookie and the returnTo bounce brings the parent back.
- **Result (verified):** platform `arrival.test.ts` A.5 (3 cases); both repos
  typecheck; Game suite 243 green.
- **Impact:** the PIN set flow completes after one real re-login; normal SSO
  bounces (no `reauth`) are untouched, so BUG_LOG #10 stays fixed.
- **Prevention:** class = **"two auth flows each correct alone, colliding at
  an unmodeled interaction"** — the freshness gate assumed login always
  re-mints; the SSO bounce assumed re-minting is never needed. A.5 pins the
  interaction. When adding a gate on session PROPERTIES (not just validity),
  check every path that's supposed to refresh those properties.
- **Related:** platform BUG_LOG #10; PRD-PARENT-AUTH-ALERT-SCOPING §7.

### 2026-07-10 — Long speech lost: mic on, but only the last sentence arrived

- **Symptom (what the user saw):** with the mic on, speaking a long request
  ("not capturing everything we speak long… only the last sentence is
  available") — the composer ended up with just the final sentence.
- **Surface area:** `src/components/useSpeechInput.ts`, new
  `src/lib/speech-transcript.ts`.
- **Root cause:** `interimResults = false` meant the Web Speech API only
  delivered FINALIZED segments — and one long unbroken monologue may finalize
  nothing until a pause. Browsers hard-end recognition sessions mid-speech
  (even with `continuous = true`); everything recognized-but-not-final was
  discarded with the session, the keep-alive restarted fresh, and only the
  last sentence (followed by a pause) ever finalized. The kid's explicit stop
  mid-sentence lost the tail the same way.
- **Fix:** `interimResults = true`; `splitSpeechResults()` (pure, unit-tested)
  splits each result event into fresh finals (committed immediately) and the
  not-yet-final interim tail; `onend` flushes the pending interim before the
  keep-alive restart — so a hard-capped session, a silence timeout, or the
  kid's stop all keep every recognized word.
- **Result (verified):** `speech-transcript.test.ts` (7 tests: long monologue
  all-interim is preserved, finalized segments never double, already-delivered
  finals never re-emit, resultIndex fallback); full suite 201 green.
- **Impact:** voice input now survives long kid monologues; no behaviour
  change for short utterances.
- **Prevention:** class = **"lossy event stream — data only committed on a
  happy-path event that may never fire."** Guarded by `speech-transcript.test.ts`;
  the flush lives in the ONE `onend` all session-end paths share.
- **Related:** mobile-hardening entry 2026-07-07 and keep-alive entry
  2026-07-09 (same hook; the keep-alive made the loss WORSE by silently
  restarting over discarded audio).

### 2026-07-10 — Footer scroll trap: once you reach the footer, no way back to the chat

- **Symptom (what the user saw):** scrolling down on the chat page revealed
  the Ariantra footer — and then the page seemed stuck; there was "no way to
  go back to the chat-window-only view."
- **Surface area:** `src/app/layout.tsx`, `src/app/globals.css` shell,
  `src/app/{parent,admin,upgrade}/layout.tsx` (new), `Composer.tsx`.
- **Root cause:** the root layout rendered `<ArFooter/>` inside `.ar-app-main`
  (the page scroller) BELOW the full-height chat screen. Scrolling back up
  required scrolling `.ar-app-main`, but the pointer sits over the chat
  message list — its own scroll region, normally at its bottom. Browser
  scroll-chaining feeds wheel-up to the INNER list first, so upward scroll
  paged back through chat history instead of un-revealing the footer.
- **Fix:** the chat is an app screen — no footer under it. `ArFooter` removed
  from the root layout; the grown-up pages (`/parent`, `/admin`, `/upgrade`)
  render it via their own tiny layouts; Terms & Privacy links moved into the
  composer disclaimer line so they stay reachable from the chat.
- **Result (verified):** `footer-placement.test.ts` (root layout has no
  footer; all three grown-up layouts do; composer carries terms/privacy
  links); full suite 201 green.
- **Impact:** kids can't get stuck below the chat anymore; footer/SEO content
  still present on every normal-scrolling page.
- **Prevention:** class = **"marketing chrome inside an app-screen scroll
  context."** `footer-placement.test.ts` fails if `ArFooter` returns to the
  root layout.
- **Related:** self-healing entry below (same day); design rule
  DESIGN_SYSTEM.md §6 (kid view is a full-height app shell).

### 2026-07-10 — Self-healing preview stuck on "Fixing…" forever + falsely "repaired" a healthy game

- **Symptom (what the user saw):** after generating a game, the preview cover
  showed "Oops — Nothing's drawing. Fixing…" with a bouncing 🔧 and never
  lifted ("it is going on a loop"). Meanwhile the SAME game, downloaded and
  opened in Chrome, worked perfectly — so a healthy game was being "repaired",
  and then the repair never landed. Prod logs proved the server side succeeded:
  `[api/repair] ✓ patch @4796ms` with no corresponding client update.
- **Surface area:** `usePreviewVerify.ts`, `preview-verify.ts` (probe script +
  classification), `verify-policy.ts`, `ArtifactFrame.tsx`.
- **Root cause:** two distinct defects. (1) **Self-cancelling effect:** the
  verify round ran inside a React effect whose dependency array included
  `phase`; the hook's own `setPhase("repairing")` re-ran the effect, the
  cleanup set the round's `cancelled` flag, and the in-flight repair
  continuation saw `cancelled === true` and dropped the server's patch —
  leaving phase stuck at "repairing" with no path forward. (2) **Probe-inference
  false positive:** `canvas_static` (pixel variance) condemned a game whose
  first real paint fell outside the sampling window; the taxonomy treated a
  weak inference with the same confidence as a thrown error, so a healthy
  game burned a Gemini call and then hit defect (1).
- **Fix:** extracted the whole verify/repair state machine into
  `src/lib/preview-verify-controller.ts` — framework-free, dependency-injected
  (fetch/track/now/timers), so no React lifecycle can cancel its own
  continuation; `usePreviewVerify` is now a thin adapter (browser events in,
  state out; disposal only on unmount/new html). Repair eligibility narrowed
  to hard-evidence codes only (`REPAIRABLE_CODES` in `verify-policy.ts`:
  load_error, async_loop, resource_404, start_occluded) — probe-inference
  codes (canvas_static, no_loop, start_no_loop, canvas_zero_size) are
  telemetry-only pass-through until live `preview_verify` data proves them.
  Also hardened in the same pass: the probe script counts `setInterval`
  loops (healthy non-rAF games no longer read as "dead"), and the parent's
  ready ack carries `verify:false` on post-verify reloads so the reloaded
  document never ghost-clicks the kid's Start button.
- **Result (verified):** `preview-verify-controller.test.ts` — "applies the
  server's patch after its OWN phase transition to repairing" (the exact
  dropped-continuation path) + 11 more controller rows; "probe-inference codes
  pass through SILENTLY"; 183 tests green. Real-browser E2E: stubbed broken
  generation (`gameLop()` ReferenceError) → cover → "Fixing…" → REAL
  /api/repair Gemini patch (HTTP 200) → cover lifted → repaired ball animating
  (screenshots r1/r2).
- **Impact:** kids can no longer be trapped behind a stuck cover; healthy
  games are never rewritten by a false probe; repair spend now only follows
  hard evidence. Telemetry still records every classification, so the
  demoted codes can be re-promoted with data.
- **Prevention:** class = **state machine inside a self-invalidating React
  effect** (an effect that mutates its own dependencies cannot await anything
  safely). The controller is plain TS with injected deps — every future flow
  change gets a node-level regression test, no browser needed. Second class =
  **treating probe inference as hard evidence**: any new failure code starts
  telemetry-only and must earn its way into `REPAIRABLE_CODES`.
- **Related:** platform `docs/PRD-SELF-HEALING-PREVIEW.md` §16, TECH_DEBT #30
  (the skipped instrument-first bake predicted exactly this false-positive
  risk); commit d419e78 (feature), this fix follows it.

### 2026-07-09 — Sidebar "Search chats" button did nothing (shipped without a handler)

- **Symptom (what the user saw):** the 🔍 "Search chats" row in the sidebar looked exactly like
  Gemini's working search entry but had no effect when tapped — a dead-end control. Surfaced by
  the gemini.google.com gap analysis.
- **Surface area:** `src/components/Sidebar.tsx`, `src/components/ChatPanel.container.tsx`.
- **Root cause:** the button was created as visual scaffolding (Gemini-parity layout) with no
  `onClick` and no search implementation behind it; nothing failed loudly, so it shipped.
- **Fix:** inline sidebar filter. New pure helper `searchChats()` (`src/lib/chat-search.ts`) does
  case-insensitive matching over conversation titles AND message text (artifact HTML deliberately
  excluded — game source matches like `div`/`function` are noise). Clicking 🔍 swaps the row for an
  autofocused input (✕ / Escape closes and clears); the container owns `searchQuery` and filters
  the `recents` memo; header shows a match count; zero matches shows "No chats found — try another
  word, or start a New chat." Picking a result or starting a new chat resets the filter.
- **Result (verified):** `chat-search.test.ts` (7 cases) written first and failing, green after
  implementation; full suite 108 passing; manual UAT — message-body search narrows the list,
  clear restores it, empty state shows on nonsense queries; mobile-drawer screenshot pass.
- **Impact:** kids/parents can now find old chats by any word they remember; no behaviour change
  for anyone who never taps search. Client-side only — no new API surface, transcripts stay local.
- **Prevention:** class = **decorative control shipped without a handler**. `chat-search.test.ts`
  guards the matching logic; visual-pass rule (CLAUDE.md hard rule: no dead-end UX) now includes
  clicking every control on the changed surface, not just looking at it.
- **Related:** gap-analysis item "conversation management"; FEATURES.md chat section updated.

### 2026-07-09 — "The connection hiccuped… Ask me again" appeared constantly → wake lock + silent auto-retry

- **Symptom:** on phones, replies frequently ended in "📶 The connection hiccuped before I
  finished (this happens if the screen locks). Ask me again and I'll redo it!" — the recovery
  work was dumped on the kid, every time the screen auto-locked mid-generation.
- **Surface area:** `src/components/ChatPanel.container.tsx` (`runStream`),
  `src/components/useWakeLock.ts` (new), `src/lib/stream-recovery.ts` (new).
- **Root cause:** two gaps on top of the 2026-07-07 keep-partial fix. (1) Nothing stopped the
  trigger: phones auto-lock during a 20–40s generation and iOS kills the socket. (2) Nothing
  retried: the client showed a "re-ask me" note instead of just re-requesting. (Unlike the real
  Gemini app, we don't persist generations server-side, so a dropped client simply loses the
  reply — see the deferred resume plan in TECH_DEBT #23.)
- **Fix:** **prevent** — `useWakeLock(busy)` holds a screen wake lock while a reply streams
  (re-acquired on `visibilitychange`; no-op where unsupported). **Recover** — on a non-manual,
  non-finalized drop or stall, `runStream` retries itself up to `STREAM_RETRY_LIMIT` (2) times:
  shows "📶 Reconnecting… hang tight!", waits for the page to be visible again + 800ms, and
  re-runs the request; `busy` stays true across retries (no flicker, Stop keeps working, and
  Stop during the wait is honored). Only after exhausted retries does the kid see a message.
- **Result (verified):** `stream-recovery.test.ts` (5 tests) green; full suite 101 passing;
  page smoke test clean (no JS errors).
- **Impact:** the common screen-lock case now self-heals invisibly. Trade-off: each retry is a
  fresh paid generation (hence the cap of 2); the durable fix (server-side resumable
  generations) is registered as TECH_DEBT #23.
- **Prevention:** class = **recovery work pushed onto the user**. The retry decision is a pure
  tested function (`shouldAutoRetry`); manual-stop and finalized replies can never retry.
- **Related:** 2026-07-07 "Oops! Something went wrong" entry (same class, first layer).

### 2026-07-09 — Model deflected "make me a chess game" to a simpler game (prompt fix)

- **Symptom:** child asked for "a chess game like any professional site" → the model refused
  twice: "quite tricky… How about something simpler?" — not a safety block, a **capability
  deflection** encouraged by our own prompt ("easy and fun for a young child") and its
  no-external-resources rule.
- **Surface area:** `src/lib/gemini.ts` (`CHILD_SYSTEM_PROMPT`).
- **Root cause:** the prompt never told the model it must BUILD what was asked; it also banned
  external resources, making rule-heavy classics (chess) genuinely hard to deliver in one shot,
  so the model bailed to "let's make a dodge game instead".
- **Fix:** prompt now (a) forbids calling a game too complicated or deflecting to a different
  simpler game — "build the game the child asked for, complete and playable, in one go";
  (b) allows well-known open-source CDN libraries via `<script src>` for rule-heavy classics
  (e.g. chess.js) so rules are professional-grade; all other games stay self-contained/offline.
  Checked: the app sets no CSP and the `sandbox="allow-scripts"` iframe permits network loads,
  so CDN scripts work in the preview.
- **Result (verified):** `gemini.prompt.test.ts` extended (deflection ban + chess.js/CDN
  allowance pinned); suite green.
- **Impact:** classic games get real rules; games needing a CDN won't run fully offline —
  accepted (owner direction: "we can import").
- **Prevention:** class = **prompt-induced refusal**; the instruction is regression-pinned so
  it can't silently disappear.
- **Related:** 2026-07-09 safety-monitor entry (the earlier chess blocker — different layer).

### 2026-07-09 — Safety monitor retracted harmless games (chess blocked) → monitor removed, prompt-level safety (owner decision)

- **Symptom:** asking for a **chess game** (and other harmless games) streamed in fully, then
  got yanked and replaced with the "Let's talk about something else!" redirect — the Flash-Lite
  output monitor mis-classified game HTML and retracted it.
- **Surface area:** `src/app/api/chat/route.ts`, `src/lib/gemini.ts` (system prompt).
- **Root cause:** the post-stream Flash-Lite output monitor judged raw game markup/JS out of
  context and returned block verdicts for benign games; any non-`allow` verdict retracted the
  already-shown reply.
- **Fix (owner decision, 2026-07-09 — accepted safety trade-off):** removed the Flash-Lite
  classifier from `/api/chat` entirely (background input classify + output monitor + retract).
  Output safety now = Gemini built-in safety thresholds (unchanged, real-time) **plus** an
  explicit child-safety system instruction in `CHILD_SYSTEM_PROMPT` ("be careful in the way you
  speak and be cautious about safety… child aged between 7 and 14"; games are always welcome,
  never refused). Deterministic input rules (`RulesClassifier`) + parent alerting on input stay.
  Side effect: per-turn cost drops from chat + 2 safety calls to chat only.
- **Result (verified):** `route.test.ts` R.1 — a streamed game reaches `done` with **no**
  `retract` event; `gemini.prompt.test.ts` pins the safety instruction. Full suite green (94).
- **Impact:** games are never blocked or retracted by the safety layer. **Posture change:** the
  LLM output check is gone — output safety relies on Gemini built-in blocking + the system
  prompt. Parent alerts now come only from the deterministic input rules. `/api/safety`
  (extension endpoint) still uses `FlashLiteClassifier` — unchanged.
- **Prevention:** class = **post-hoc retraction of benign content**. R.1 locks "no retract
  after done"; `gemini.prompt.test.ts` locks the replacement instruction so it can't silently
  disappear.
- **Related:** FEATURES.md "Game-action exemption" (2026-07-06) — same class, earlier layer
  (Gemini thresholds); PRD §F2 updated; SCALABILITY_ISSUES #4 re-scoped.

### 2026-07-09 — Mic stopped by itself mid-sentence (kid still talking)

- **Symptom:** the mic turned itself off after the first pause in speech — a kid telling a
  longer story had to keep re-tapping the mic.
- **Surface area:** `src/components/useSpeechInput.ts`, `src/lib/mic-errors.ts`.
- **Root cause:** `SpeechRecognition.continuous` was `false`, so the browser ended the session
  at the first silence; `onend` just set `isListening=false`. Browsers ALSO end continuous
  sessions on longer silence, and "no-speech" errors surfaced as if the mic broke.
- **Fix:** `continuous = true`; `onresult` reads only NEW results (`e.resultIndex`) so restarts
  don't duplicate text; a `wantListeningRef` keep-alive silently restarts recognition in `onend`
  until the kid stops it; only fatal errors (`isFatalMicError`: permission / hardware / network)
  end the session — pause-class errors ("no-speech", "aborted") auto-restart.
- **Result (verified):** `mic-errors.test.ts` (isFatalMicError suite) green; manual pass —
  mic stays on across multi-sentence dictation until ⏸/toggle.
- **Impact:** the mic now listens until explicitly stopped. Battery/privacy note: it no longer
  turns itself off — the listening banner + pulsing icon stay visible the whole time.
- **Prevention:** class = **session auto-teardown treated as user intent** (same family as the
  2026-07-07 recognizer-teardown bug). The fatal/non-fatal split is a pure tested function.
- **Related:** 2026-07-07 mobile mic hardening entry.

### 2026-07-09 — Composer polish: inner focus box, no auto-grow, misleading "flash lite" chip

- **Symptom:** (a) clicking the prompt drew a second box (blue ring) INSIDE the rounded
  composer; (b) long prompts didn't expand the box (stuck at one line, tiny scroll);
  (c) a "flash lite ⌄" chip implied a model picker and the wrong model name.
- **Surface area:** `src/components/Composer.tsx`, `src/components/ChatPanel.container.tsx`.
- **Root cause:** (a) the global `:focus-visible` ring in `globals.css` — text fields always
  match `:focus-visible`, so the a11y ring rendered inside the pill; (b) `rows={1}` with no
  height sync to content; (c) leftover display-only label.
- **Fix:** textarea gets `focus-visible:ring-0` (the pill itself is the focus affordance;
  the global ring stays for everything else); auto-grow effect syncs height to `scrollHeight`
  capped at `max-h-40` then scrolls; model chip + `model` prop removed.
- **Result (verified):** typecheck + suite green; visual pass at desktop and 375px — multi-line
  prompts grow the pill, no inner box, no model chip.
- **Impact:** UI-only. The composer now matches the Gemini-style single-pill look.
- **Prevention:** class = **global base style leaking into a composed control** — noted here;
  any new inset input inside a styled container needs the same ring exemption check.
- **Related:** none prior.

### 2026-07-07 — "Oops! Something went wrong" after the code streamed in (mobile socket drops)

- **Symptom:** on the phone, the game code streams in, then the whole reply is
  REPLACED by "Oops! Something went wrong. Let's try again." Server error log
  spammed with `stream error: Invalid state: Controller is already closed`.
- **Investigation (measured):** server completes fine via curl (79 deltas +
  done); real WebKit browser against prod completes a 29s AND a 38s
  generation with a heavy persisted chat store — hypothesis "chat-store jank"
  REJECTED. The only consistent read: the CLIENT's socket dies mid-stream
  (server enqueue throws "already closed"; client sees a non-abort stream
  error). Failure timings (~20s, and 1–3s on retries) fit iOS killing
  sockets on screen auto-lock / app switch during the generation wait.
- **Root cause (handling, not prevention):** the socket drop itself is the
  phone's prerogative — but the app made it catastrophic: the client threw
  away everything already streamed and showed a dead-end "Oops"; the server
  kept enqueueing into the dead controller, one ERROR per token.
- **Fix:** client keeps the partial reply and appends a friendly note
  ("connection hiccuped — ask me again, this happens if the screen locks");
  server `ndjson()` turns sends into no-ops after the first failed enqueue
  (one info line, generation + safety monitor finish quietly).
- **Result:** typecheck + 64 tests green. Prevention class: streamed UX must
  survive client disconnects — never discard streamed content, never
  hard-error a dead socket.
- **Open question (honest):** the exact phone-side trigger is inferred from
  timing, not observed. If Oops-style failures persist AFTER this ships with
  the screen kept awake, reopen with the phone's remote-inspector console.

### 2026-07-07 — SSO login never synced to kidgemini (env, not code): AUTH_JWT_SECRET differed between the apps

- **Symptom:** login at studio.ariantra.com → back on kidgemini → still
  signed out; "Put it in the Arcade" could therefore never publish (screen
  recording repro). Also the partner bridge returned 403.
- **Root cause (measured chain, no code defect):** kidgemini's `.env` on the
  box carried a DIFFERENT `AUTH_JWT_SECRET` than the platform's. That one
  value is both the partner-bridge shared secret AND the key kidgemini uses
  to verify the `ariantra_session` cookie — so platform-minted logins could
  never validate here. Proven remotely: the bridge 403'd (secret compare in
  code), flipped to 200 the moment the secrets were aligned.
- **Fix (ops):** owner copied the platform's AUTH_JWT_SECRET line into
  kidgemini/.env on the box (never displayed) + `pm2 restart kidgemini`.
- **Result (verified):** bridge check → HTTP 200 `{free:true}`. Login sync
  uses the identical verification path.
- **Prevention:** `deploy:all` already has an SSO-secret preflight — extend it
  to compare the REMOTE `.env`s (the drift was on the box, not locally).
  Class: one shared secret, one source of truth.

### 2026-07-07 — Mic "did nothing" on phones; generated games overflowed the small preview

- **Symptom (what the user saw):** tapping 🎤 on a phone produced nothing —
  no listening, no message. Separately, generated games assumed a big screen
  and didn't work in the ~400px preview panel.
- **Surface area:** `useSpeechInput.ts`, `Composer.tsx`, new
  `lib/mic-errors.ts`; `gemini.ts` (system prompt).
- **Root cause (mic, three code-level defects):** (1) the recognizer was
  destroyed/recreated EVERY render (the setup effect depended on an inline
  callback prop) — iOS WebKit drops sessions when the instance churns;
  (2) `onerror` swallowed every failure, so permission-denied /
  dictation-off / no-speech looked like a dead button; (3) no secure-context
  guard — plain-http (LAN-IP dev) silently blocks the mic API.
- **Fix:** one recognizer per mount (callback via ref); error codes map to
  kid-friendly banners (`micErrorMessage`, unit-tested) shown above the
  composer; `isSecureContext` required for `isSupported`. Games: the
  server-side system prompt now REQUIRES fully responsive games (100%
  container sizing, canvas resize handling, no horizontal overflow at 380px)
  — enforced before the kid's words ever reach Gemini.
- **Result (verified):** Playwright: mocked `not-allowed` recognizer → the
  friendly "allow the microphone" banner renders; live generation → the game
  fits a 400px viewport with zero horizontal overflow. 64 tests green.
- **Prevention:** mic-errors.test.ts; class = browser-API failures must be
  surfaced to the kid, never swallowed. Real-iOS caveat: the banner now
  REPORTS the true reason (e.g. Siri & Dictation off), so a phone repro after
  deploy becomes self-diagnosing.
- **Related:** 2026-07-07 preview-trap entry (same mobile UAT sweep).

### 2026-07-07 — Mobile game preview was a trap: nav swallowed every exit tap; publish bar sat on game controls

- **Symptom (what the user saw):** on a phone, once the game preview opened
  there was NO way back to the chat — ← Chat and ✕ looked fine but did
  nothing. Separately, the "Put it in the Arcade" bar covered the game's own
  bottom touch controls.
- **Surface area:** `ChatPanel.container.tsx` (overlay z-index),
  `ArtifactFrame.tsx` (header layout, publish placement).
- **Root cause:** the fullscreen artifact overlay used `z-40` while the sticky
  brand nav (`.ar-nav`) is `z-100` — the nav floated invisibly over the
  panel's header strip and intercepted every tap on ← Chat/✕ (caught by
  Playwright: "ar-logo-word … intercepts pointer events"). The publish CTA was
  a full-width bar under the preview, exactly where generated games put their
  on-screen buttons.
- **Fix:** overlay `z-[110]` (above the nav; publish sheet `z-[120]`); publish
  moved into the panel header as a compact 🚀 pill; Download/Copy collapse to
  icons on phones so the header always fits 390px. Also: suggestion chips are
  now four GAME starters (racing/space/dino/puzzle) — kidgemini is a
  game-making platform (user decision 2026-07-07).
- **Result (verified):** Playwright on iPhone-14 viewport, real generation:
  ← Chat tap returns to chat ✓, "🎮 Open game" chip reopens ✓, header fits ✓,
  game's bottom controls unobstructed ✓. 61 tests green.
- **Prevention:** class = fullscreen overlays must stack ABOVE the sticky nav
  (z ≥ 110); any tap-dead UI report → check for pointer interception first
  (Playwright names the intercepting element).
- **Related:** 2026-07-06 artifact-panel entry (same surface).

### 2026-07-07 — Chat lost on any navigation; publish flow asked for PIN before sign-in

- **Symptom (what the user saw):** navigating to Studio (or any sign-in round
  trip) wiped the whole conversation; the "Put it in the Arcade" sheet asked
  for the parent PIN first, THEN discovered the family was signed out and sent
  them to Studio — losing the chat and the game on the way.
- **Surface area:** `ChatPanel.container.tsx`, `PublishToArcade.tsx`,
  new `src/lib/chat-store.ts`.
- **Root cause:** conversations lived ONLY in React state — nothing persisted
  client-side (server keeps safety transcripts, but the UI never reloads
  them). And the publish sheet's step order checked auth last instead of
  first, with a new-tab Studio link instead of the existing `signIn()`
  round-trip.
- **Fix:** (1) chat-store.ts persists conversations to localStorage (cap 20,
  never throws; one-shot restore guarded by a ref — StrictMode's double
  effect pass otherwise clobbers the restore with the fresh greeting convo).
  (2) The sheet now checks the SSO session FIRST (`useSession`) and shows a
  "sign in — your chat is safe" step before naming/PIN; `signIn()` returns to
  the same page and the chat survives.
- **Result (verified):** Playwright — conversation ids stable across reload
  AND leave-site-and-return; 61 tests green.
- **Impact:** kids can hop between kidgemini, Studio, and sign-in without
  losing work; the publish flow asks the family for things in a sane order.
- **Prevention:** chat-store.test.ts (round-trip, cap, corrupt-data). Class:
  UI state a kid invested effort in must survive navigation.
- **Related:** "kidgemini shows signed-out even after Studio login" is NOT
  this bug — that's the box-side AUTH_JWT_SECRET alignment (platform BUG_LOG
  #5 partner 403 has the same root); verify with the .env diff on the box.

### 2026-07-06 — Artifact Code tab didn't scroll; on mobile the preview trapped the user (no visible way back to chat, closed games unrecoverable)

- **Symptom (what the user saw):** (1) Switching the artifact panel to **Code**
  showed the top of the game's HTML with no scrollbar — the rest was cut off.
  (2) On a phone the preview covers the whole screen; the only exit was the
  small ✕, and once closed there was no way to ever reopen that game.
- **Surface area:** `src/components/ArtifactFrame.tsx`,
  `src/components/MessageItem.tsx`, `src/components/ChatPanel.container.tsx`.
- **Root cause:** the `<pre>` used `h-full flex-1` inside the flex column —
  `h-full` sized it to 100% of the panel *on top of* the header rows, so the
  code block overflowed past the panel bottom and its own `overflow-auto`
  scrollbar never engaged (the correct flex-scroll idiom is `flex-1 min-h-0`).
  For (2): messages persist `artifactHtml`, but nothing in the UI rendered a
  reopen affordance, and the fullscreen mobile overlay relied solely on ✕.
- **Fix:** `ArtifactFrame.tsx` — `min-h-0 flex-1` on both the code `<pre>` and
  the preview iframe (dropped `h-full`); added a mobile-only "← Chat" back
  button in the panel header. `MessageItem.tsx` + `ChatPanel.container.tsx` —
  assistant messages carrying `artifactHtml` now render a "🎮 Open game" chip
  that reopens the preview, so closing it is never a dead end.
- **Result (verified):** `npx tsc --noEmit` clean; full suite 42/42 green.
  Presentational-only change — needs one manual UAT pass: generate a game,
  Code tab scrolls to the bottom, close on mobile via "← Chat", reopen via the
  chip.
- **Impact:** kids on phones can move freely between the game preview and the
  conversation; generated code is fully readable.
- **Prevention:** class = *flex child with its own scroll must be
  `flex-1 min-h-0`, never `h-full`* (second member of this class: the chat
  scroll region already uses `min-h-0 flex-1` correctly). No component test
  harness exists yet (vitest is node-env, `.test.ts` only) — covered by the
  UAT step above until the component-testing retrofit (KNOWN_BUGS #1) lands.
- **Related:** 2026-06-25 entry (same mobile-UAT blind spot).

### 2026-06-25 — Guest chat silently hung on mobile ("Thinking…" forever); login was never surfaced

- **Symptom (what the user saw):** On mobile, while **not** signed in, sending a prompt did nothing — the UI showed "Thinking… 💭" and never produced an answer or an error. Signing in fixed it. The app appeared to "force login" but gave the user no way to discover that.
- **Surface area:** `src/app/api/chat/route.ts` (guest path), `src/components/ChatPanel.container.tsx` (stream consumer), and the absence of any upfront sign-in UI.
- **Root cause:** Two compounding defects of the **silent-failure class**:
  1. **No upfront auth gate / signal.** Guests were allowed to chat; "sign in" was delivered only *reactively* as a single in-band NDJSON line (`{type:"gate"|"rate_limited"|"paywall"}`) inside an HTTP **200** streamed body — there was no status code to react to. If that tiny body was delayed/buffered (mobile proxy/tunnel) or the guest path errored, nothing surfaced.
  2. **Client never checked `res.ok` and force-unwrapped the body** (`res.body!.getReader()`). Any non-streaming response (4xx/5xx/body-less) produced no parseable event, so the UI stayed "Thinking…" until the 30s stall timeout — a silent hang.
- **Fix:**
  - Server: force sign-in upfront — `route.ts:58` returns **HTTP 401 `auth_required`** for unauthenticated callers *before* any Gemini call (fail-closed; closes the anonymous LLM-cost path). Guest gate/rate-limit code retained but unreachable while the gate is in force (product decision: keep, don't delete).
  - Client: gate the whole experience on `useSession()` — render the new `SignInScreen` when `unauthenticated`, a quiet placeholder while `loading`, chat when `authenticated` (`ChatPanel.container.tsx`). The composer no longer renders for guests, so a guest can't even start a request that would hang.
  - Client: added a fail-loud `if (!res.ok || !res.body)` guard in `runStream` (`ChatPanel.container.tsx`) — non-streaming responses now surface an error/sign-in prompt instead of stalling.
- **Result (verified):** `src/app/api/chat/route.test.ts` (2 tests) — unauthenticated POST ⇒ 401 **and** `replyStream` never called; authenticated POST streams. Full suite green (12 tests); `npm run typecheck` clean.
- **Impact:** Unauthenticated users now see a clear sign-in screen instead of a silent hang; no anonymous request can spend Gemini tokens. Behaviour change: guests can no longer chat at all (was: chat free up to `GUEST_TOKEN_LIMIT`).
- **Prevention — name the class:** **silent failure** (a) *silent hang on a non-streaming/blocked response* — pinned by the `res.ok` guard + 401 contract test; (b) *open anonymous cost path* — pinned by "Gemini never called when unauthenticated". Any future block/gate must travel as an HTTP status the client checks, never only as an in-band event.
- **Related:** First entry. Registered in `docs/REGRESSION-TEST-CATALOG.md` (Safety & gate contracts).
- **Follow-up (2026-07-03):** guest/trial mode RESTORED per PRD §10a (product decision) — the
  dormant guest branch is live again, but every gate now travels as an HTTP status (401/429/402),
  so the silent-hang class this entry named cannot recur. Pinned by `route.test.ts` G.1–G.4/S.1–S.3.
