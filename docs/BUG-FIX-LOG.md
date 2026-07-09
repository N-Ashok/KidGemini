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
