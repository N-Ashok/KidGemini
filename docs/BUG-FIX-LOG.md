# Bug-Fix Log

Project-wide record of bugs that reached the codebase, what was actually fixed, the verified
result, and the broader impact. The **single source of truth** for "what went wrong, what we did,
what changed." Governed by the Bug-Fix Protocol in `CLAUDE.md` §9.

- **Open bugs / in-progress** → `docs/KNOWN_BUGS.md`
- **Which tests guard which code** → `docs/REGRESSION-TEST-CATALOG.md`

Entries are **newest first**. Don't rewrite history — fix forward with a new entry.

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
