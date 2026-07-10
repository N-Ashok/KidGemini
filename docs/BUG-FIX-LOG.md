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
