# PRD-PROMPT-CACHING — making Gemini implicit caching actually hit

**Status: PLANNED — nothing implemented yet.** This document is the full plan:
what the request looks like today byte-by-byte, why the cache hit rate is ~4%,
exactly what changes in each fix, the savings arithmetic, and the UAT that
proves game quality did not drift. Companion docs: `COST_TOKEN_BUDGET.md`
(waste ledger #4 — this PRD is its continuation), `PROMPT_MANAGEMENT.md` (the
current prompt reference — update it in the same change that ships each fix),
`BUG-FIX-LOG.md`.

---

## 1. The rule everything hinges on

Gemini **implicit caching** (automatic, free, no code) caches the longest
**byte-identical prefix** of a request, in this serialization order:

```
[ systemInstruction ][ history message 1 ][ message 2 ] … [ final user message ]
```

- One changed byte kills the cache **from that point onward** — everything
  after the first divergence is billed at the full input rate.
- It is **position-sensitive**: the same 12K-token game moved two messages
  later is a miss, not a hit.
- Minimum cacheable prefix ≈ **1–2K tokens** (bare chat turns can fall under).
- TTL is **minutes** (not guaranteed; observed ~3–15 min). A kid who plays for
  10 minutes between edits comes back cold — that part we cannot fix.
- Billing: cached prompt tokens appear in `usageMetadata.cachedContentTokenCount`
  (a **subset** of `promptTokenCount`) and bill at the cached-input rate.

**Pricing that the whole savings model uses** (`model-registry.ts`, verified
against ai.google.dev 2026-07-13/14):

| gemini-3-flash-preview | $/MTok |
|---|---|
| input (uncached) | **$0.50** |
| input (cached) | **$0.05** — a **90% discount** on the cached portion |
| output (incl. thinking) | $3.00 |

So every 1M tokens moved from "billed" to "cached" saves **$0.45 ≈ ₹43**
(at ₹95/$).

## 2. Baseline — measured, not guessed

Local dev DB (`data/kidgemini.db` → `usage_events`), primary model only:

| when measured | scope | rows | billedPromptTokens | cachedTokens | cached % |
|---|---|---|---|---|---|
| 2026-07-24 (trailing 14d) | all kinds | 225 | 1,135,094 | 42,482 | **3.7%** |
| 2026-07-25 (trailing 14d) | kind=chat | 176 | 1,185,965 | 52,679 | **4.4%** |
| 2026-07-25 (trailing 14d) | chat+repair | 192 | 1,283,751 | 54,712 | **4.3%** |

Per-turn averages (14d, primary, dev): chat avgPrompt **6,738** (max 16,592),
avgOutput+thinking 2,596; repair avgPrompt 6,112, avgOutput 253. Dev turns run
smaller than the edit-heavy 20K representative in §5.1 because dev
conversations are short and games small — both cases are modeled there.

Fallback-model rows (gemini-2.5/3.5) sit at ~0% — expected: a fallback or
hedge loser hits a **different model's** cache, which is always cold. That is
structural and out of scope.

Reproduce / re-measure (works on the box too — see COST_TOKEN_BUDGET.md
"Ad-hoc DB queries" for the prod path and its no-double-quotes quirk):

```sql
SELECT COUNT(*), SUM(billedPromptTokens), SUM(cachedTokens),
       ROUND(100.0*SUM(cachedTokens)/SUM(billedPromptTokens),1)
FROM usage_events
WHERE model='gemini-3-flash-preview' AND createdAt >= <cutoff-ms>;
```

**Caveat carried over from waste ledger #4:** dev traffic (many short fresh
conversations, dev-server restarts) understates what prod continuous sessions
would cache. The three defects below are structural, not dev artifacts — but
final judgement of each fix is the **prod** pre/post split by `createdAt`.

## 3. The request today — exact anatomy

Assembly: `configFor()` picks the system instruction
(`gemini.ts:616`), `trimHistory()` shapes history (`history-trim.ts:64`),
`buildChatContents()` serializes (`gemini.ts:448`).

### 3.1 System instruction (first bytes of every request)

| Turn condition | Instruction | ≈ tokens |
|---|---|---|
| Pre-game plain chat (`!isGameBuildTurn`) | persona base only | ~1,300 |
| Any turn once a game exists / message says "game"/"3d" | base + gated sections | up to ~6,000 |

Sections layered by `buildTurnSystemInstruction()` (`gemini.ts:353`).
Token sizes below MEASURED 2026-07-25 from the live exports at chars÷4 (a
slight over-estimate for prose; COST_TOKEN_BUDGET.md's older, smaller figures
for base/3D/catalog were tokenizer counts — treat these as the upper band):

| Section | Gate | ≈ tokens | Stable within a conversation? |
|---|---|---|---|
| Persona base (child / bible-teacher) | persona (fixed per session) | ~1,310 | ✅ |
| `THREE_PROMPT_SECTION` | 3D keyword in msg **or history** | ~730 | ✅ monotonic — flips ON once, stays |
| `modelsPromptSection()` (whole catalog) | with 3D | ~1,060 | ✅ static since 2026-07-24 |
| `audioPromptSection()` | audio keyword, monotonic | ~320 | ✅ monotonic |
| `MULTIPLAYER_PROMPT_SECTION` | multiplayer gate, monotonic | ~2,150 | ✅ monotonic |
| `GAME_EDIT_PROMPT_SECTION` | `isEdit` this turn | ~360 | ⚠️ flips OFF on forceFullRegen (2D→3D conversion turns stopped reaching the model entirely on 2026-07-26 — they answer with the new-game panel, no model call) |
| `REPEATED_REQUEST_SECTION` | exact re-send of last message | ~110 | ❌ per-turn |

All-gates instruction: **~5,570 tokens** without edit/repeated (the post-Fix-C
stable shape), **~6,040** at today's maximum.

**Honest re-ranking vs the first analysis:** `isGameBuildTurn` is already
**sticky** (`builder-mode.ts:22` — any `artifactHtml` in history → build
branch), and once a game exists `isEdit` is true on almost every turn. So the
instruction churns **less** than first suspected: within one gamed
conversation it changes only on (a) the pre-game→post-game flip, (b) each
monotonic gate unlock, (c) a `repeated` turn (2 misses: on and off). (A 2D→3D
conversion turn used to be a fourth flip — since 2026-07-26 it never reaches
the model: it answers with the new-game info panel and the build happens in a
fresh chat.) Killer #1 is real but third-place. The
instruction defects are cheap to fix and worth fixing (every flip is a miss at
**token zero**), but the big money is §3.2 and §3.3.

### 3.2 History — the sliding window (killer #1)

`HISTORY_WINDOW = 12` (`history-trim.ts:17`). Past 12 messages (~6 exchanges
— *early* in a real session), **every turn drops the oldest message**, so the
first history message differs every turn → cache dead from the end of the
system instruction onward. Worse, rule 3 (`history-trim.ts:80`) swaps the
**game-bearing message** (10–15K tokens) into slot 1 when it falls off the
window — so the very first history bytes alternate between a huge game blob
and ordinary prose.

### 3.3 History — the mutating game blob (killer #2, the token bulk)

`trimHistory` inlines the **newest game's full HTML (~10–15K tokens)** into
its assistant message (`withInlineGame`), and:

- after every successful edit, the *previous* game message is rewritten to
  `GAME_OMITTED_PLACEHOLDER` — bytes at that position change → miss from there;
- the new version appears at a new position with new bytes;
- patch-turn messages (prose-only text) get the game re-inlined from
  `artifactHtml` — so the biggest single block in the prompt is guaranteed to
  differ turn-over-turn on every iteration.

### 3.4 Final user message

The child's message (10–100+ tokens), plus image bytes on image turns.
Changes every turn by definition — that's fine, it's the tail.

### 3.5 Requests NOT touched by this PRD

`strictEditRetry` (already tail-shaped: history-free, game+ask in one user
message), `repair` (own prompt, rare), one-shot patch-fallback regeneration,
non-Google fallback slots. All keep their current shape.

## 4. The fixes — exact new shape, step by step

Ship order: **Fix A (hysteresis window) → Fix B (game to tail) → Fix C
(stable instruction)**. A is behavior-neutral to the model (same messages,
different trim cadence); B and C change what the model sees and carry the UAT
in §6. Each fix is a separate commit with its own test updates, so a drift
bisects cleanly.

### Fix A — hysteresis window instead of sliding window

`history-trim.ts`: keep `HISTORY_WINDOW = 12` as the **cut-to** size; add
`HISTORY_WINDOW_MAX = 24`. Trim only when `stripped.length > 24`, and then cut
to the last 12 in one step.

- Turn-over-turn, history is **append-only for ~12 turns at a stretch**;
  the prefix shifts once per cut instead of every turn.
- Average context grows from ~12 to ~18 messages — costs ~1–2K extra prose
  input tokens per turn, repaid many times over by the cache discount on the
  now-stable prefix (arith in §5.3).
- Natural future home for threshold compaction (summarize-on-cut) — out of
  scope here, noted in TECH_DEBT.
- The carry-the-game rule (rule 3) stays but becomes moot after Fix B.
- **Cut on a user-message boundary**: after the cut, if the window opens on an
  assistant message, drop that message too. `slice(-12)` today can open the
  window mid-pair; a dangling assistant reply adds no context and Gemini
  history reads cleanest opening on a user turn. Costs at most one extra
  dropped message per cut.
- Tests: `history-trim` unit tests updated for the new cadence; new pins:
  "no trim between thresholds" (the cache invariant) and "window never opens
  on an assistant message".

### Fix B — game source moves from mid-history to the tail

New shape (build/edit turns once a game exists):

```
[ systemInstruction (stable) ]
[ prose history — append-only; EVERY game message shows a stable placeholder,
  written once and never rewritten ]
[ final user message — exact part order (pinned by test):
    part 1 (image turns only): inlineData — keeps today's image-first pin
                               in gemini.contents.test.ts
    part 2 (text):  "Current game source:\n```html\n<newest-or-pinned game>\n```"
                    + GAME_EDIT_PROMPT_SECTION      (edit turns — Fix C)
                    + REPEATED_REQUEST_SECTION      (repeated turns — Fix C)
                    + "The child asked: <message>"  (the ask stays LAST —
                       recency position for the model) ]
```

- `trimHistory` stops inlining (`withInlineGame` deleted); **all** game
  messages — including the newest — carry a placeholder. Placeholder text is
  written into the trimmed copy once per message and never changes afterwards
  (bytes stable ⇒ prefix stable). Wording updated so "the newest version
  appears later in this conversation" becomes "…is attached to the child's
  latest message".
- The route/gemini composes the tail from `currentGameHtml(history, pinnedId)`
  — the **same** source `applyPatch` runs against, so SEARCH blocks still
  match server truth exactly. Rewind pins keep working (pinned version is what
  rides the tail).
- Rule 3 of `trimHistory` (swap the game-bearing message into slot 1 when it
  falls off the window) is **deleted**, not left moot — the tail carries the
  source on every turn regardless of window position, and keeping dead code
  that reorders history is exactly the kind of byte-instability this PRD
  exists to kill. Rewind pins keep working through `currentGameHtml(history,
  pinnedId)` alone.
- This is the shape `strictEditRetry` **already uses in production** — the
  model demonstrably patches correctly against it.
- **Deferred, do NOT ship in B:** skipping the game block on non-edit turns
  mid-conversation ("what's 7×8?" doesn't need 12K of game source). Tempting
  ~12K saving on off-topic turns, but it rides on `isGameEditTurn` being
  right; a false negative would strand an edit with no source. Revisit only
  with prod evidence that off-topic-mid-game turns are a material share of
  spend (TECH_DEBT entry, measured via the edit-branch log line).
- Consequences: the 10–15K game block can no longer invalidate the prose
  history behind it. The game itself is **never cached** (it sits in the
  changing final message) — accepted; it was effectively never cached before
  either, and there is no position where a *mutating* block can hit.
- Tests: `gemini.contents.test.ts` (new pinned request shape),
  `history-trim` tests (placeholder-always), route edit-branch integration
  tests, `game-edit` NEW_GAME_SENTINEL flow unchanged.

### Fix C — stable system instruction; volatile directives ride the tail

- `GAME_EDIT_PROMPT_SECTION` and `REPEATED_REQUEST_SECTION` leave
  `systemInstruction` and are appended to the **final user message** (after
  the game source, before/around the child's ask — exact order pinned by
  test). The edit contract is per-turn guidance; the tail is where per-turn
  bytes belong.
- After this, the build-turn instruction = persona base + monotonic catalog
  gates only ⇒ **byte-identical for the whole conversation** from each gate
  unlock onward, and identical across *all* conversations with the same gate
  set (cross-conversation hits become possible on the ~4,400-token prefix).
- (The 2D→3D conversion turn already stopped perturbing the instruction on
  2026-07-26 — it never reaches the model; the fresh-chat build arrives as an
  ordinary `forceRebuild` first turn.)
- **Reorder the monotonic sections by invalidation cost.** Today's order in
  `buildTurnSystemInstruction` is `THREE + models, audio, MULTIPLAYER`. A gate
  unlock invalidates every byte AFTER its insertion point — so the ~320-token
  audio section sitting in FRONT of the ~2,150-token multiplayer section means
  a late audio unlock (a kid asks for sound effects mid-session) throws away
  the whole multiplayer block behind it. New order: `THREE + models,
  MULTIPLAYER, audio` — the smallest, likeliest-late section goes last, so its
  unlock invalidates nothing behind it. General rule, pinned in a code
  comment: sections are ordered largest/earliest-unlocking first,
  smallest/latest-unlocking last. (This reorders instruction bytes, so it
  lands INSIDE the Fix C commit with its prompt-contract test updates — never
  as a drive-by.)
- **Determinism pin:** `modelsPromptSection()` and `audioPromptSection()` are
  function calls — a new test pins that two calls return byte-identical
  strings (a future catalog shuffle or timestamp would silently zero the
  cache).
- NOT moved: the persona base and monotonic sections stay in
  `systemInstruction` (they're stable — moving them buys nothing and risks
  authority dilution of safety instructions).
- Tests: `gemini.prompt.test.ts` prompt-contract pins move with the text;
  new pin: "instruction bytes identical across consecutive edit turns".

### 4.4 The prompt, before → after — byte for byte

Two consecutive edit turns of one real session ("make the penguin faster" →
"add a score bonus"), all gates on, history already past the window. `▓` marks
where the cache dies — everything after it bills at the full input rate.

**TODAY — turn N vs turn N+1** (~4% cached):

```
turn N                                    turn N+1
──────────────────────────────────────    ──────────────────────────────────────
[systemInstruction]                       [systemInstruction]
  persona base            ~1,310            persona base            (identical)
  THREE + models + audio  ~2,110            THREE + models + audio  (identical)
  MULTIPLAYER             ~2,150            MULTIPLAYER             (identical)
  GAME_EDIT               ~360              GAME_EDIT               (identical)
[history msg 1]                           ▓[history msg 1]  ← OLDEST DROPPED —
  user: "add a jump button"                 different message now sits here;
                                            every byte from this point is a MISS
[history msg 2..11]                        [what was msg 2..12, shifted up one]
  …incl. assistant msg with the FULL        …the game blob moved position AND
  game inlined (~12,000 tok) — and          the pre-edit version was rewritten
  after each edit the PREVIOUS game         to GAME_OMITTED_PLACEHOLDER —
  message is rewritten to a placeholder     changed bytes mid-prefix
[final user msg]                          [final user msg]
  "make the penguin faster"                 "add a score bonus"
──────────────────────────────────────
cacheable prefix on turn N+1: just the system instruction… IF no gate/edit
flag flipped. Measured result: 4.3%.
```

**AFTER A+B+C — same two turns** (forecast 35–50% on within-TTL turns):

````
turn N                                    turn N+1
──────────────────────────────────────    ──────────────────────────────────────
[systemInstruction]                       [systemInstruction]      ✅ CACHED
  persona base            ~1,310            byte-identical — GAME_EDIT and
  THREE + models          ~1,790            REPEATED are gone from here (they
  MULTIPLAYER             ~2,150            ride the tail); only a monotonic
  audio (now last)        ~320              gate unlock can ever change it
[history msg 1..18]                       [history msg 1..18]      ✅ CACHED
  prose only; every game message shows      SAME BYTES — window didn't move
  a stable placeholder written once       [history msg 19..20]     (new, billed)
                                            last turn's ask + reply, APPENDED —
                                            nothing above them changed
[final user msg]                          ▓[final user msg]  ← the only miss
  Current game source:                      Current game source:
  ```html                                   ```html
  <penguin game v3, ~12K tok>               <penguin game v4 — new bytes, fine:
  ```                                       this block sits BEHIND everything
  GAME_EDIT section        ~360             cacheable instead of in front of it>
  "The child asked: make                    ```
   the penguin faster"                      GAME_EDIT section
                                            "The child asked: add a score bonus"
──────────────────────────────────────
cacheable prefix on turn N+1: instruction (~5,570) + history (~3,000) ≈ 8.5K
of a ~21K request. Misses only at: window cut (1 per ~12 turns), gate unlock
(≤3 per conversation), TTL expiry.
````

The before/after in one sentence: today the request's **only stable bytes are
the instruction** and even those flip; after, **everything except the final
user message is frozen**, and the one block that must change every turn (the
game source) is quarantined at the end where it can't invalidate anything.

### What deliberately does NOT change

- `applyPatch` matching (server `currentHtml` — untouched).
- Safety settings, thinking budgets, output caps, fallback chain, hedging.
- Stored conversations / UI (trimming remains a model-view concern).
- **Deferred:** explicit `CachedContent` (paid storage + lifecycle complexity
  — revisit only if free caching still under-delivers), Anthropic
  `cache_control` on fallback slots (fallbacks are rare).

## 5. Savings — the arithmetic

### 5.1 Per-turn forecast (edit-heavy session, all gates on)

Representative edit turn ≈ 20K prompt tokens:

| Block | ≈ tokens | Cacheable after fixes? |
|---|---|---|
| System instruction (all gates) | ~5,570 (post-C: stable) | ✅ every within-TTL turn |
| Prose history (placeholders + chat) | 2,500–4,500 | ✅ between window cuts |
| Game source at tail | 10,000–15,000 | ❌ never (mutates) |
| Child's message | 10–100 | ❌ tail |

⇒ forecast cached fraction on within-TTL iteration turns: **~35–50%**
(≈ 8–10K of ~20K). On the smaller turns dev actually averages (6,738 prompt
tokens — small game or no 3D/multiplayer gates), the stable instruction is
most of the request, so the per-turn ceiling is *higher*; what drags a
session down is misses right after a window cut, a gate unlock, or a TTL
expiry. Committed **session-level band: 25–45%**, against today's 4.3%. (The
"40–70%" quoted in the chat conversation was before discovering the
game-at-tail block can never hit — treat **25–45%** as the committed
forecast; anything above is upside.)

### 5.2 Cost formula

Input-cost multiplier at cached fraction x: `1 − 0.9x`.

| cached % | input-cost multiplier | input saved vs today (x≈0.044) |
|---|---|---|
| 4.4% (today) | 0.960 | — |
| 25% | 0.775 | **19%** |
| 35% | 0.685 | **29%** |
| 45% | 0.595 | **38%** |

### 5.3 What that means in money

On the dev-DB 14-day input volume (1.284M prompt tokens ⇒ ~$0.62 ≈ ₹59 of
input at today's 4.3%): at 35% cached, input drops to ~₹42 — saving **~₹17
per 1.28M prompt tokens**, i.e. **~₹13 saved per million prompt tokens** at
the 35% point (₹43/MTok × 0.31 net new cached fraction). Scale that to any
future volume: input spend × (saved fraction from the §5.2 table).

Where it actually bites — **patch-mode edit turns**, the product's hot loop:
input ~20K ($0.010 ≈ ₹0.95) vs patch output ~500 tokens ($0.0015 ≈ ₹0.14) —
input is **~85%** of a patch-edit turn's cost. At 40% cached the turn drops
from ~₹1.09 to ~₹0.75 (**−31%**). Full-build turns stay output-dominated
(10–20K output at $3/MTok); caching doesn't touch output, so **whole-session
savings land at roughly 15–30%** depending on the build:edit mix. Fix A's
extra ~1.5K prose tokens/turn costs ~₹0.07/turn uncached and less once the
prose is the part that caches — strictly net-positive at any hit rate above
~15%.

Honesty note: the hit-rate is a **forecast**; the spend split is measured.
The committed claim is the mechanism + the measurement plan, not a guaranteed
percentage. The measurement is free: `cachedTokens` already lands per-row in
`usage_events` and per-turn in the Sparks ledger's `tokensCached`.

### 5.4 Acceptance thresholds (decided now, so the numbers can't be re-argued later)

- **Success:** prod cached% (primary model, `createdAt` after deploy, ≥3 real
  kid sessions ≥10 turns) ≥ **25%**.
- **Investigate:** 10–25% — pull `logs/model-decisions.jsonl` + a debug
  prompt dump, find the residual divergence point.
- **Failure / rollback trigger:** <10%, or any §6 UAT regression that can't
  be fixed forward in a day.

## 6. UAT — proving the model didn't drift

Fixes B and C change what the model sees. The risk is **edit quality**: does
patching still behave when the source arrives in the final user turn instead
of mid-history? (Mitigating prior: `strictEditRetry` already works this way.)

### 6.1 Automated (before any UAT)

- Full suite green; the prompt-contract tests (`gemini.prompt.test.ts`,
  `gemini.contents.test.ts`, `multiplayer-prompt.test.ts`,
  `prompt-catalog.test.ts`) updated **in the same commit** as each fix.
- New cache-invariant pins: (1) instruction bytes identical across
  consecutive edit turns; (2) trimmed history bytes for turn N are a prefix
  of turn N+1's between window cuts; (3) game source present exactly once
  per request, at the tail; (4) trimmed window never opens on an assistant
  message; (5) final-message part order = [image?][game → edit section →
  repeated section → ask]; (6) `modelsPromptSection()`/`audioPromptSection()`
  return byte-identical strings across calls.

### 6.2 Golden-session UAT script (live, dev, ~20 min)

One conversation, in this exact order — it walks every request shape:

1. **Plain chat** ("what's your favourite animal?") → normal chat, no game.
2. **First build**: "make me a penguin maze game" → complete, playable game.
3. **Small edit ×3**: "make the penguin faster" / "add a score bonus" /
   "change the walls to ice blue" → each lands as a **patch** (watch the
   server log for the edit branch, not regeneration); untouched parts —
   colors, controls, layout — stay byte-identical (this is the drift canary;
   compare the HTML between versions, not just gameplay).
4. **Repeated message**: paste the same edit twice → second reply changes
   approach, doesn't re-claim success (REPEATED_REQUEST_SECTION still fires
   from its new tail position).
5. **Off-topic mid-game** ("what does my game do?" then "what's 7×8?") →
   plain prose answers, no patch markers, no rebuild.
6. **New-game ask** ("now make me a space shooter") → NEW_GAME_SENTINEL flow
   (the fresh-chat question), not a silent overwrite.
7. **2D→3D conversion** ("make it 3D") → the two-games info panel appears
   instantly (owner decision 2026-07-26); OK opens a fresh chat seeded with
   the 2D game and builds a full Three.js game there — never a faked-depth
   patch, and the 2D chat keeps its game.
8. **Long-session window cut**: keep chatting past ~24 messages → edits still
   find the game (it rides the tail regardless of window position).
9. **Rewind pin**: "Continue from here" on an older version → next edit
   builds on the pinned version.
10. **Image turn**: attach a drawing + "make the player look like this" →
    request carries game + image + message without error.

Pass = every step behaves as it does today. Steps 3, 6 and 7 are where
tail-source drift would show first.

### 6.3 Before/after cache measurement

Run the §2 query on the dev DB before starting, once after each fix's UAT
session, and on prod split by deploy `createdAt` after shipping. Record all
three rows in COST_TOKEN_BUDGET.md waste ledger #4.

### 6.4 Rollback

Each fix is one commit; revert restores the previous request shape exactly
(no data migration — trimming is per-request). Optional belt-and-braces: gate
B and C behind one env flag (`PROMPT_CACHE_SHAPE=legacy`) mirroring the
existing `GAME_EDIT_PATCH=off` kill-switch pattern — decide at implementation
time; if added, it must be a single choke point in `configFor`/`trimHistory`.

## 7. Doc updates that ship WITH the code (repo rule)

- `PROMPT_MANAGEMENT.md` — rewrite the assembly tables for the new shape.
- `COST_TOKEN_BUDGET.md` — waste ledger #4 gains the fix-by-fix measurements.
- `BUG-FIX-LOG.md` — not a bug; no entry unless UAT finds one.
- `REGRESSION-TEST-CATALOG.md` — the new cache-invariant pins.
- `TECH_DEBT` (platform repo) — threshold-compaction follow-up on Fix A.
