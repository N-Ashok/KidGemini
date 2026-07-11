# PRD — Self-Healing Preview (kidgemini)

**Status:** proposed · **Owner:** platform · **Repo:** `../Game` (kidgemini)
**Related:** `AI_INTEGRATION_PROMPT.md` §1 · TECH_DEBT #22 · BUG-FIX-LOG protocol §7.4

---

## 0. For the implementing agent — analyse before you build

This PRD is written from the outside. Five facts about the current preview
determine large parts of the implementation, and **none of them are assumed here.**
Read the code, answer these, then build.

| # | Question | Where to look | Why it decides things |
|---|---|---|---|
| A1 | Is the preview iframe `srcdoc`, a blob URL, or a fetched URL? | the preview component in `../Game/src` | Same-origin → instruments touch `contentWindow` directly (§5). Cross-origin → they must be injected into the game HTML as a `<script>` before the game's own script, reporting via `postMessage`. Same logic, ~3× the code. |
| A2 | Does the existing error listener attach **before** the game script executes, or on `load`? | wherever the console-tab-open is triggered | If it attaches on `load`, it is **currently blind to load-time throws** — the most common failure class, and the one `AI_INTEGRATION_PROMPT.md` §1 exists to prevent. Fixing this alone may be most of the win. |
| A3 | Does it capture the full `ErrorEvent` (message + filename + line + stack), or only a string? | same | A stack is a repair input. `"Error"` is not. |
| A4 | Where does the generated game HTML live between the Gemini response and the iframe? | the chat → preview handoff | The verify pass needs to intercept it there. |
| A5 | Does the chat call path already retain the previous game source for iteration? | `src/lib/gemini.ts` and callers | Non-destructive repair (§7.1) needs the prior version to diff against and to roll back to. |

**Do not skip §14 (Rollout).** Step 1 is instrument-only, repair disabled. Building
the retry loop before knowing the failure distribution risks paying Gemini tokens
forever for something one prompt line would prevent.

---

## 1. Problem

A kid asks for a game. Gemini writes it. The preview renders — and sometimes the
game is broken. Today, three things happen, all bad:

1. **A console error fires** → the kid is switched to the console tab and shown a
   stack trace. A nine-year-old cannot read `TypeError: Cannot read property 'x'
   of undefined at gameLoop (index.html:247)`. The one entity that *can* read it —
   the model that wrote line 247 — never sees it.
2. **The Start button does nothing**, silently. No error. Nothing to show, nothing
   to explain.
3. **The game is unplayable by design** (enemy spawns on top of the player). Runs
   perfectly. Ends in 0.8 seconds.

The kid's first experience of their own creation is a failure they cannot diagnose,
caused by a machine, presented as if it were theirs to solve.

**Every error signal already exists in the preview.** It is routed to the wrong
recipient.

---

## 2. Goals

- **G1** A kid never sees a console tab. Ever.
- **G2** A kid never sees a broken game — errors are caught and repaired before
  first render.
- **G3** Silent failures ("Start does nothing") are detected and repaired, not just
  crashes.
- **G4** When repair fails, the kid gets a question, not an apology and never a
  stack trace.
- **G5** Repair costs bounded tokens and bounded wall-clock time (§8, §12).

### Non-goals

- **Judging whether the game is *good*.** No probe knows if the ghost is scary
  enough. Only the kid does.
- **Fixing unplayable-by-design games (problem 3).** That is a `CHILD_SYSTEM_PROMPT`
  contract, not a probe — see §10.
- **Touching published games.** This is the chat preview only. Published games in
  `sites/{slug}/` are permanent and out of scope. Never auto-rewrite a live game.

---

## 3. Design principle

> **The kid judges intent. The machine judges execution.**

The model wrote the bug and holds the source. It should fix its own bug, silently,
before the kid has an opinion to form. The kid's attention is reserved for the only
question a machine cannot answer: *is this the game you wanted?*

---

## 4. Architecture

Insert a **verify pass** between generation and the kid's first look.

```
Gemini returns game HTML
        │
        ▼
  ┌──────────────────────────┐
  │ iframe, RENDERED, COVERED│  see §8.1 — it cannot be display:none
  │  · error trap            │
  │  · rAF counter           │
  │  · probes (§6)           │
  └────────┬─────────────────┘
           │
      ┌────┴────┐
      │ clean?  │
      └────┬────┘
     yes   │   no
      │    │
      │    ▼
      │  repair prompt (§7) ──► Gemini ──► patched HTML ──┐
      │        │                                           │
      │        │  attempt ≤ 2, total wall clock ≤ 20s      │
      │        └───────────────────────────────────────────┘
      │        │
      │        │  exhausted
      │        ▼
      │   ask the kid a question (§9.1) — never the console
      ▼
  uncover — the kid sees a working game
```

Two properties make this cheap:

- **The game is a string in memory**, not a deployed artifact. Nothing is permanent
  yet. No restamp, no S3, no rollout mechanism.
- **The kid's browser runs the game**, not our box. Zero cost against the 1 GB
  memory budget. No headless Chrome. No `capture-queue` contention.

---

## 5. Instrumentation

Installed on the iframe's window **before the game's script executes**. This timing
is non-negotiable — a listener attached on `load` misses the most common failure of
all: the game that dies before `gameLoop()` ever runs. (See A2.)

### 5.1 Error trap

```js
const errors = [];
w.addEventListener('error', e => errors.push({
  kind: 'error',
  message: e.message,
  filename: e.filename,
  line: e.lineno,
  col: e.colno,
  stack: e.error?.stack,       // the stack is the fix; the message alone is not
}));
w.addEventListener('unhandledrejection', e => errors.push({
  kind: 'rejection',
  message: String(e.reason),
  stack: e.reason?.stack,
}));
```

Also capture failed subresource loads (`error` events with a `target`, captured on
the window): a 404'd import-map CDN is a distinct, trivially-fixable class.

### 5.2 Frame counter

```js
w.__rafCount = 0;
const origRaf = w.requestAnimationFrame;
w.requestAnimationFrame = function (cb) {
  w.__rafCount++;
  return origRaf.call(w, cb);
};
```

`__rafCount === 0` after render means **the game loop never started** — the single
highest-signal bit in this system, and it fires with no exception thrown.

---

## 6. Probes (silent-failure detection)

Run after a settle period (~1.5s). Cheapest first; stop at the first failure.

| # | Probe | Detects |
|---|---|---|
| P1 | `__rafCount > 0` (no click) | Loop never started. Per `AI_INTEGRATION_PROMPT.md` §1 the loop **must** run synchronously on load, so a static game is a contract violation. |
| P2 | `canvas.width/height > 0` | Canvas sized only in CSS; nothing can paint. |
| P3 | Pixel variance across 800ms | Loop runs, screen frozen. |
| P4 | Locate start control | Only if P1 shows no loop — some games legitimately have none. |
| P5 | `elementFromPoint(btnCenter) === btn` | **Occlusion.** The handler is fine; the click never reaches it. |
| P6 | `btn.click()` → `__rafCount` delta > 0 | Handler ran but the loop still didn't start (flag mismatch). |

### 6.1 Why P5 is the sharp one

`elementFromPoint` answers the literal question — *if a kid taps here, what gets the
click?* — and the browser answers authoritatively. Most "the Start button doesn't
work" games have a working button underneath an overlay left at
`pointer-events: auto`.

### 6.2 Why P6 must dispatch directly

`btn.click()` fires on the element and **bypasses occlusion**. That is deliberate:

- P5 fails + P6 starts the loop → the handler works, the overlay is the *only* bug.
  One-line fix.
- P5 passes + P6 does nothing → the handler runs and the loop ignores it. Different
  bug, different fix.

Distinguishing these is the difference between a targeted patch and a full
regeneration that scrambles everything the kid liked.

---

## 7. Failure taxonomy → repair prompt

The taxonomy **is** the product. A vague "it's broken" gets a coin-flip rewrite. A
precise failure gets a surgical patch that preserves the game the kid was already
watching take shape.

| Code | Repair instruction sent to Gemini | Kid-facing line (§8.3) |
|---|---|---|
| `load_error` | The game threw `{message}` at `{filename}:{line}`. Stack: `{stack}`. Fix only that. | "Something broke. Fixing it…" |
| `async_loop` | (`load_error` whose stack shows `await`/`async` near init) The game loop was wrapped in an async function. Per the platform contract, canvas layout, `generateWorld()`, `startLevel()` and `gameLoop()` must run immediately and synchronously on script load. Move them out. | "Getting the game started…" |
| `resource_404` | `{url}` failed to load. Replace it with a working CDN URL in the import map. | "One of the pieces didn't download. Getting it again…" |
| `no_loop` | `requestAnimationFrame` was never called. The game loop never started. | "The game isn't moving yet. Fixing…" |
| `canvas_zero_size` | The canvas has zero width/height. Set `canvas.width`/`canvas.height` in JS, not only in CSS. | "The screen was the wrong size. Fixing…" |
| `canvas_static` | The loop runs but the canvas never repaints. | "Nothing's drawing. Fixing…" |
| `start_occluded` | The Start button at `({x},{y})` is covered by `{selector}`, so taps never reach it. Give that element `pointer-events: none`, or hide it when the game starts. **Do not change the button's handler — it works.** | "The Start button was hiding behind something. Fixing it…" |
| `start_no_loop` | Clicking Start ran its handler, but `requestAnimationFrame` was still never called. The flag the handler sets is probably not the flag the loop checks. | "Start wasn't starting anything. Fixing…" |
| `no_start_button` | No start control found and the loop is not running. | "The game isn't moving yet. Fixing…" |

Every repair prompt carries: the failure code, the concrete evidence, the current
source, and **the kid's original request** (so a fix never drifts from intent).

### 7.1 Repair must be a minimal patch, not a regeneration

Ask Gemini to **return only the changed block**, not the whole file. This buys two
unrelated things at once:

- **Safety.** If fixing a dead Start button also regenerates the sprites and the
  level, the kid loses the game they were watching take shape.
- **Speed.** Repair latency is dominated by *output* tokens. Re-emitting 400 lines
  costs ~30s. Emitting an 8-line patch costs ~4s. **5–10× faster** (§8.2).

For `start_occluded` the correct fix is literally one CSS property.

Retain the previous source. A repair that changes more than it should is worse than
the bug it fixed.

---

## 8. UX & latency

### 8.1 The iframe must be rendered — the cover screen is a correctness requirement

**The verify iframe cannot be `display: none`.** Browsers throttle or entirely skip
`requestAnimationFrame` for iframes that aren't rendered or don't intersect the
viewport. A perfectly healthy game would report `__rafCount === 0` and the system
would "repair" a game that was never broken.

So the iframe is **on-screen, rendered, painting** — with an opaque cover card drawn
over it.

```
┌─────────────────────────┐
│  ▓▓▓▓ cover card ▓▓▓▓   │  ← the kid sees this
│                         │
│  [ live iframe below,   │  ← rAF ticks, probes run
│    rendered, painting ] │
└─────────────────────────┘
```

The loading state and the correctness requirement are the same object.

**Two mandatory guards:**
- Skip verify entirely if `document.hidden` at start.
- If the tab loses focus mid-window (`visibilitychange`), treat `no_loop` as
  **inconclusive** — pass it through rather than triggering a false repair. rAF
  stops when a tab is backgrounded.

### 8.2 Latency budget

| Phase | Time | Kid's experience |
|---|---|---|
| Generation (today) | 15–45s | Already waits |
| **Verify** | **~2.5s** | Rounding error on the above |
| Repair — full regeneration | 15–40s | ❌ unacceptable |
| Repair — **minimal patch (§7.1)** | **3–6s** | ✅ tolerable |
| Re-verify | 2.5s | — |
| **Worst case, 2 patched repairs** | **~19s** | Within the bail cap |

Verify is free — it disappears into the tail of a wait the kid is already in.
**Repair is the only real cost, and §7.1 is what makes it affordable.**

### 8.3 The three states

**State 1 — Building.** The existing generation wait, unchanged.

Use this dead window for the thing that actually improves intent-match: a question
the kid can answer.

> *"Building your game… while I finish: when the player gets hit, should they lose
> a life, or start over?"*
> `[ lose a life ]  [ start over ]`

Zero added time. The answer applies to the **next** turn — do not block on it, do
not regenerate because of it.

**State 2 — Testing (~2.5s).** Cover card over the live iframe. A short, honest
checklist reflecting **real probe results**, not a fake progress bar:

```
Testing your game…
  ✓ It runs
  ✓ The screen is drawing
  ⟳ Checking the Start button
```

Kids like watching things get checked. It's 2.5s — long enough to read, short enough
not to bore. **Do not pad it.** If the probes finish in 1.2s, uncover at 1.2s.

**State 3 — Fixing.** Only when a probe fails. Say it plainly, using the kid-facing
line from the §7 table:

> *"Oops — the Start button was hiding behind something. Fixing it…"*

Kids trust a thing that admits it stumbled. The message is truthful, specific, and
derived from the failure code, which you already have.

Second attempt: *"Still not quite right. One more try…"* Then stop.

### 8.4 The bail rule

**Cap total verify + repair wall clock at ~20 seconds**, regardless of what the
attempt counter says. If the clock blows past it, uncover the best version you have
and let the kid tell you what's wrong. The "This doesn't work" button carries the
probe telemetry along with whatever they type, so nothing is lost.

A game that's imperfect and *there* beats a spinner.

> The failure mode to fear isn't a broken game. It's a kid who waited ninety seconds
> and got nothing.

---

## 9. Retry policy & fallback

| Setting | Value | Why |
|---|---|---|
| Max repair attempts | **2** | The third rarely converges; cost compounds. |
| Verify settle | 1.5s + 1.0s post-click | ~2.5s. |
| Total wall-clock cap | **20s** | §8.4 bail rule. Overrides the attempt counter. |
| Repair model | `GEMINI_CHAT_MODEL` | Repair needs the same code competence as generation. |
| Repair output | **minimal patch** (§7.1) | Safety + 5–10× latency. |

### 9.1 When repair is exhausted

The kid never sees the console, the stack trace, or the failure code. They see a
question — which converts a dead end into the articulation loop that actually
improves intent-match:

> *"Hmm, that one didn't come out right. Let me try a different way — should the
> ghost chase you, or wander around?"*

Two properties matter:
- **It's honest.** Something did go wrong.
- **It's productive.** A kid cannot author a spec, but a kid can answer a choice.

---

## 10. Out of scope: unplayable-by-design (problem 3)

An enemy spawning on top of the player throws no error, ticks rAF happily, and
repaints every frame. All probes pass. **The game works; the design is bad.**

This is a prompt contract, not a probe — the same class of rule as
`AI_INTEGRATION_PROMPT.md` §1, which exists because Gemini reliably got the async
loop wrong until it was told not to. Proposed `CHILD_SYSTEM_PROMPT` additions:

- No enemy, obstacle or hazard within the first **3 seconds** of play.
- The player spawns at a safe distance from every hazard — never overlapping, never
  adjacent.
- Difficulty ramps: the first spawn is slow; spawn rate increases with time.
- At spawn, the player always has at least one escape move available.

A model told "3 seconds" writes `setTimeout(spawnEnemy, 3000)`. Prompt rules are
unglamorous and they work.

**Batch with TECH_DEBT #22** (the deferred `CHILD_SYSTEM_PROMPT` tightening) so game
quality is re-UAT'd once, not twice.

### 10.1 Optional follow-on (not v1)

If Gemini declares its controls —
`<meta name="ariantra:controls" content="ArrowLeft,ArrowRight,Space">` — a probe can
press keys and measure **idle death time** (press nothing; game-over under ~2s =
unplayable) and **random-agent survival**. Neither proves the game is fun; both
catch "you die instantly." Defer until §10's prompt rules are measured.

---

## 11. Instrumentation & success metrics

Mixpanel is already on kidgemini, IP-less and fully masked. Add:

| Event | Props | Answers |
|---|---|---|
| `preview_verify` | `outcome: clean\|repaired\|failed\|bailed`, `attempts`, `failure_code`, `ms` | How often is the first generation broken? Which class dominates? |
| `preview_repair` | `failure_code`, `attempt`, `success`, `ms` | Which repair prompts actually converge? |

**Primary metric:** % of previews reaching the kid clean on **first render**.

Baseline unknown — instrument the probes *before* wiring repair, and measure for a
week. That number says whether this is a common problem or a rare one, and which
failure code belongs in the prompt rather than the retry loop.

**A repair that fires constantly is a prompt bug, not a feature.** If `async_loop`
dominates, the fix belongs in `CHILD_SYSTEM_PROMPT`, where it costs zero tokens per
game.

**Secondary:** turns-to-publish (are kids iterating, or settling?); and whether a kid
plays their own game after publishing it. If they publish and never play, the game
isn't theirs.

---

## 12. Cost

| Path | Cost |
|---|---|
| Verify pass | **$0** — runs in the kid's browser |
| Clean game (expected majority) | **$0** — no extra Gemini call |
| One patched repair | 1 chat call: source in, ~8 lines out |
| Worst case | 2 patched repairs |

Because §7.1 makes the repair emit a patch rather than the file, input tokens
dominate — cheaper and faster than a regeneration.

Still: for a guest on `GUEST_TOKEN_LIMIT`, **two failed repairs could consume a
meaningful slice of their trial.** A kid burning their free session on a bug they
didn't cause is the worst possible outcome.

> **Decision required:** exempt repair calls from the guest token budget, or cap
> repairs at 1 for guests. **Recommend exempt** — the kid didn't ask for the bug.

---

## 13. Test plan (per BUG-FIX-LOG §7.4 — tests first)

Pure functions over fixture game HTML; no live browser needed for most rows.

| # | Case | Expected |
|---|---|---|
| V.1 | Game throws on load | `load_error` with message + line |
| V.2 | Game wraps loop in `async` | `async_loop` |
| V.3 | Import-map URL 404s | `resource_404` with the URL |
| V.4 | Game never calls rAF | `no_loop` |
| V.5 | Canvas sized only in CSS | `canvas_zero_size` |
| V.6 | Start button under a full-screen overlay | `start_occluded` + the occluding selector |
| V.7 | Handler sets `gameStarted`, loop checks `isPlaying` | `start_no_loop` |
| V.8 | Healthy game, loop runs on load | `clean`, start-probe never runs |
| V.9 | Healthy game with a legitimate Start button | `clean` after P6 |
| V.10 | `document.hidden` at verify start | verify skipped, game passes through |
| V.11 | Tab backgrounded mid-window | `no_loop` treated as inconclusive, no repair |
| R.1 | Repair prompt for `start_occluded` names the occluding selector | contains selector + `pointer-events` |
| R.2 | Repair caps at 2 attempts | third attempt never issued |
| R.3 | Wall clock exceeds 20s | bails, uncovers best version (§8.4) |
| R.4 | Exhausted repair | returns a kid-facing question, never a stack trace |
| R.5 | Repair prompt includes the kid's original request | intent preserved |
| R.6 | Repair returns a patch, not a full file | changed region only |

V.6, V.7, V.10 and V.11 are the ones worth writing first — the failures with no error
to catch, plus the two false-positive traps that would make the system repair healthy
games.

---

## 14. Rollout

1. **Answer §0.** Read the preview component. A2 alone may be most of the win.
2. **Instrument only.** Ship the verify pass with repair **disabled**; log
   `preview_verify`. One week. Learn the real failure distribution.
3. **Prompt fixes for whatever dominates.** Cheapest possible fix; zero per-game cost.
4. **Enable repair** for the residue, cap 2, patch-only, 20s bail.
5. **`CHILD_SYSTEM_PROMPT` grace-period rules** (§10), batched with TECH_DEBT #22.
6. **Remove the console tab** from the kid-facing preview. Keep it behind the parent
   PIN if it's useful for debugging.

Step 2 before step 4 is the discipline that matters. Building the retry loop before
knowing whether `async_loop` is 80% of failures means paying tokens forever for
something one prompt line would have prevented.

---

## 15. Open questions

1. §0 A1–A5 — answerable only from the code.
2. **Guest token budget for repairs** — exempt, or cap at 1? (§12)
3. **Does the kid see the repair happen?** §8.3 recommends **visible** — a truthful
   "fixing it…" beat buys latency cover and builds trust. A silent swap is more
   magical but teaches the kid nothing when it fails.
4. **Where does the cover card live in the component tree?** It must sit above a
   *rendered* iframe (§8.1), which constrains layout more than a normal spinner.
