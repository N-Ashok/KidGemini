# One-pager — safety, quality and cost batch (2026-08-15 → 16)

**Status: built and green locally, NOT deployed.** Production is on `046759e`. Everything below is
uncommitted in the Game repo (`../Game`); the platform repo is untouched.

**Gate:** 2,736 tests / 222 files passing, `tsc --noEmit` clean, 19/19 placement, 271/271 batch
parity, 11/11 delivered golden games run clean in a real browser.

Detail lives in `docs/BUG-FIX-LOG.md` (2026-08-15 and 2026-08-16 entries) and `docs/KNOWN_BUGS.md`
(#16, #17, #18). This page is the map.

---

## 1. Nothing edits a child's game unless she asked

The proactive draw-call auto-fix sent a silent model turn that rewrote her game. It looped (the
one-shot guard was keyed on `docKey`, and every successful fix mints a new one) and it stripped
every mesh out of a game mid-play. Owner: *"it broke the whole game. all the meshes were gone… kids
don't know about sparks"* and *"i didnot ask for it but opening game does it automatically"* — it
fires on the first perf snapshot of a draw-call-bound scene, so merely opening a saved game was
enough.

| What | Where |
|---|---|
| `AUTO_FIX_ENABLED = false` — the proactive path is OFF | `src/lib/slowdown-nudge.ts` |
| `autoFixBoundsAllow()` — the rules, kept tested underneath the switch so it can never return unbounded | same |
| `MAX_AUTO_FIXES_PER_SESSION = 2` (session-scoped, **not** per document — that distinction *is* the bug) | same |
| `AUTO_FIX_MUST_HELP_RATIO = 0.9` — no second attempt unless the first measurably cut draw calls | same |
| Session refs (`autoFixCountRef`, `lastAutoFixDrawCallsRef`) rather than per-document state | `src/components/ArtifactFrame.tsx` |

**The tap-to-fix banner is untouched** — the child chooses it, watches it happen, and the result is
hers.

## 2. …and a speed fix can never make the game worse — whoever asked for it

Switching the trigger off was half an answer: the banner sends the identical hint, so the identical
deletion was one tap away. The guard now sits on the **result**.

- **`src/lib/scene-census.ts`** (new) — `sceneCensus()`, `censusRegression()`, `CENSUS_FLOOR_RATIO`.
  Counts **copies in the world**: `loadModel` 1, `loadModelBatch(name, n)` n,
  `new InstancedMesh(…, n)` n, `new Mesh` 1.
- The new game is **discarded, and the running one stays on screen**, if a model name vanished, or
  the world shrank below 60%.
- **Why copies and not construction calls:** a correct instancing fix deletes hundreds of
  `new Mesh(...)` calls *by design*. Counting calls would reject exactly the edit the hint asks for
  and leave every slow game slow forever. Both directions are pinned in tests.
- Scoped to the two "make it faster" paths via `handleSend(..., { protectSceneFrom })`. An ordinary
  edit may legitimately remove things ("take the trees out"); a speed fix never may.

## 3. The build-progress line stops leaking

Four defects in one strip of UI, all seen in production.

| Symptom | Cause | Fix |
|---|---|---|
| `🛠️🛠️ Making …` | `ArtifactFrame` renders a hardcoded 🛠️ **and** a line that already carries a derived emoji | hardcoded one renders only when the line brings none |
| `🏆` for "**Pin**point**ing**" | keyword table matched bare fragments (also 🦘 for "s**hop**ping", ⚾ for "foot**ball**") | every entry word-anchored, `src/lib/build-narration.ts` |
| `I'm now identifying the root cause of the draw calls` shown to a child | `kidThoughtLine` only ever asked *is this code?*, never *is this about the child's game?* | `ENGINEER_JARGON` reject in `src/lib/kid-thought.ts`, fails closed (keeps the previous line) |
| `Making "The game is good only issue is that the humans a…"` | the fallback quotes the child's own words, chopped at 48 chars — announcing we are building her complaint | a long ask returns `undefined`; caller uses its plain "Making your update…" line |

## 4. Games that save a high score no longer die

**Found by the golden run — its first catch.** The preview iframe is `sandbox="allow-scripts"` with
no `allow-same-origin` (an opaque origin), where reading `localStorage` **throws**. A game that
loads its best score while building state dies at init: title screen paints, **Start button dead**.

- **`src/lib/assets/storage-shim.ts`** (new) — `ensureStorageShim()`, `STORAGE_SHIM_MARKER`. A
  memory-backed stand-in for `localStorage` *and* `sessionStorage`, installed ahead of the game's
  first script. Tries the real API first, so published games (a normal origin) are untouched.
- Applied **before** `ensureAssetRuntime`'s plain-2D early return — the games that need it are
  exactly the ones the 3D floor declines to touch.
- Scores don't persist; they can't, in an opaque origin. A game that plays and forgets beats one
  that won't start.
- Proven in that exact iframe before shipping: bare → dead button; floored → it plays.

## 5. Cheaper edit turns (~21,000 → ~9,900 tokens)

- **`src/lib/assets/strip-runtime.ts`** (new) — `stripInjectedRuntime()`, `isInjectedBlock()`,
  `strippedTokenSaving()`. Removes OUR injected runtime from the copy the model reads (~8,470
  tokens/edit, 62–65%). Signatures key on **assignment** (`window.loadModel =`), never a mention,
  because every modern game *calls* these constantly.
  The property that matters: the child's own code survives **byte-identical**, or every
  SEARCH/REPLACE patch quoting it would miss and she'd silently lose her edit.
- **Persona split** in `src/lib/gemini.ts` — `CHILD_PERSONA_CORE` (~400 tokens) always rides;
  `personaBaseForTurn(persona, isEdit)` drops the build contract on edit turns, since a contract
  already executed in the game needn't be re-sent.
- `withInlineGame` now inlines the **stripped** artifact (`src/lib/history-trim.ts`).

## 6. Invented model names resolve to real ones

- **`src/lib/assets/model-alias.ts`** (new) — `MODEL_ALIASES`, `resolveModelName()` returning
  `{name, via}` with via ∈ exact/normalized/alias/plural/compound/typo/none. Deterministic, no
  extra model call.
- Governing rule: **prefer no match over a wrong one.** A missing model leaves the game's own
  placeholder, which a child accepts; a wrong model puts a strange object in her world.
  `TYPO_MIN_LENGTH = 6` exists because an earlier version turned `lake` into `cake`.
- Measured basis: across every stored game the model asked for 99 distinct names — 97 real,
  2 invented (`stegosaurus` ×5 → `dino`, `mermaid` ×1 → correctly unmatched).

## 7. Curves are taught but not yet vendored — **awaiting your authorisation**

The first complete golden run had **2 of 13 prompts produce a game the pipeline refused to serve**:
`curvy-track` (`CatmullRomCurve3`, `TubeGeometry`) and `chase-camera` (a `cdnjs` module URL). The
lints, the corrective retry and the fatal-artifact refusal all worked — nothing broken reached a
child — but she got "try again" instead of a game.

**We opened that gap ourselves:** withholding the tile kit moved the prompt to teaching roads as
geometry along a curve, and the served bundle exports neither class.

- Bundle rebuilt with both: **621 KB, budget 650** (`scripts/vendor-three.mjs`).
- Proven, not assumed: the actual refused game, re-run against the rebuilt bundle, drives clean.
- **Blocked on one owner-authorised command** (a PutObject to `assets.ariantra.com`):
  `node --env-file=../Ariantra-Platform/.env scripts/vendor-three.mjs --upload`

**Until then the names are deliberately NOT taught**, and that ordering is now enforced rather than
remembered:

- **`src/lib/assets/three-exports.published.json`** (new) — what the **served** bundle exports,
  written only by a verified upload (stage 4).
- `curated-imports.test.ts` and the prompt-contract test now check against **that file**, not the
  vendoring recipe. Editing the recipe does not change the content-hashed file every game already
  loads — teaching a name before its bundle ships is exactly what killed a child's game on
  2026-08-15, and is now a test failure instead.

## 8. The golden-prompt harness can finish, and tells the truth

- **`ipGuestTokenCap()`** in `src/lib/gate.config.ts` — the per-IP guest cap (20,000 tokens /
  rolling 2 days) is now env-overridable via `IP_GUEST_TOKEN_CAP`, read per request. **A tunable,
  not a bypass:** the gate still runs, counts and walls; only the number moves, and only where the
  variable is set. **Fails closed** on empty/junk/zero/negative/Infinity. Documented in
  `.env.example` as local-dev only. Pinned at the helper (`gate.config.test.ts`) and at the route
  (`route.test.ts` G.3b/G.3c, both directions).
- `scripts/golden-prompts.mjs` — no longer aborts the whole run on one failure (it threw away four
  already-paid-for games), **judges the delivered artifact rather than the streamed text** (it had
  been saving games no child would ever see), reports refusals as their own category, and exits
  non-zero on a partial run.
- `golden/prompts.json` — 7 → 13 prompts, each with a `why` tied to a real failure.

## 9. Prompt and policy changes

- **Intent, not verbatim** — `THREE_INTENT_RE` (realistic / lifelike / real-looking) gates 3D on.
  Confirmed on a real turn: "make me a realistic car game with real looking cars" → `3d=true`,
  9 models, no literal "3d" anywhere.
- **Plain chat answers again** — `looksLikePlainChat()` plus an explicit (A) change-the-game /
  (B) they-are-talking-to-you decision in the edit prompt.
- **The road/race-track tile kit is withheld** from the model entirely; roads are taught as
  geometry. Manifest entries and helpers remain so ~200 stored games keep working.
- **Cartoonish removed, guns allowed** as a normal part of children's play
  (`src/lib/safety.config.ts`); confirmed end-to-end — `shooter-guns` passed the input gate and
  plays.
- `physics` catalog gate (`src/lib/assets/catalog-gate.ts`) so the cannon-es playbook only ships
  when it's wanted; the engine-agnostic movement-feel section always rides.

---

## What is owed

1. **Deploy.** Every fix above is local. Production still auto-fixes on open, still doubles the
   emoji, still leaks the engineering thought, still kills games that save a score.
2. **Authorise the bundle upload** (§7) so curvy tracks and chase cameras stop being refused.
3. **Look at the 11 golden games.** They run clean; mechanical checks cannot see a track whose
   corners don't meet. `node scripts/golden-prompts.mjs --accept <id>` records your verdict.
4. Owner review of the 139 curated `realSize` values — my curation, unreviewed.
5. Prompt caching is still 0 hits across 1,774 calls, uninvestigated.
