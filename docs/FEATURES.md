# Ari (formerly KidGemini) — Features (one-pager)

What the app does today. Product intent: `PRD.md`; system map: `ARCHITECTURE.md`.

## Parent area (`/parent`, PIN-gated)
- **Family profile signpost** (2026-07-13): a card linking to the Studio's
  Creator Profile deep link (`studio.ariantra.com/studio?profile=1`) — the
  ONE place parent/child details are collected (encrypted platform-side).
  Ari deliberately hosts no second form; SSO makes the hop seamless
- **🎮 Multiplayer on/off toggle** (2026-07-14, Phase 4 of
  `../Ariantra-Platform/docs/PRD-MULTIPLAYER.md` — the first on/off toggle
  built on this page): one switch per published game; off means friends can
  no longer be invited into a live "Play together" session on that game.
  Same PIN + family-ownership gate as approving a publish
- **⏱️ Daily screen-time cap + alert** (2026-07-15,
  `docs/PRD-SCREEN-TIME-CAP-MVP.md`): a parent sets a daily-minutes cap;
  minutes are derived from presence pings — one per chat completion plus a
  lightweight client heartbeat (`ScreenTimeHeartbeat.tsx`) while the tab is
  open and visible, so playing an already-built game counts the same as
  chatting — and crossing the cap fires exactly one alert into the same list
  as safety alerts. Alert-only — nothing is blocked, and the kid sees no
  timer at all.

## Chat (home `/`)
- Gemini-powered kids chat: text + voice (TTS playback, regenerate last answer)
- **Server-side chat history** (2026-07-13, TECH_DEBT #26 shipped): every
  conversation (messages + generated game HTML) persists in SQLite keyed by
  the account (signed-in) or the guest device cookie — chats survive cleared
  localStorage and follow a signed-in kid across devices. The sidebar Recents
  is an infinite list: first 30 from the server, more load on scroll ("Older
  chats…"); opening a server-only chat fetches its messages on demand.
  localStorage is now just the warm cache (its quota trims oldest-first,
  never the active chat). One-time migration uploads a device's pre-existing
  chats on the first visit after the update; independently, **claiming a
  guest's server-side history on login** (2026-07-18, BUG-FIX-LOG) reassigns
  the guest cookie's rows to the account the moment both identities show up
  on one request, regardless of what's left in localStorage. Ownership
  fail-closed at the SQL layer (`/api/chats*`, `SqliteChatHistoryStore`);
  write-through happens once per finished turn, never per streamed token
- **Chat ⋮ menu — Rename / Pin / Delete** (2026-08-06, owner ask; supersedes
  the lone hover-✕ of 2026-07-26): each sidebar row has a hover-revealed ⋮
  (same subtle reveal as the old ✕) opening a per-row menu, like other chat
  apps. **Rename**: in-row editor (Enter/Escape), `PATCH /api/chats/:id
  { title }` — deliberately does NOT bump `updatedAt`, so renaming an old
  chat never reorders Recents; the container's auto-title only fires while
  the title is still "New chat", so a manual name is never clobbered.
  **Pin**: `PATCH { pinned }` stamps a `pinnedAt` column; pinned chats sort
  FIRST in Recents (📌 badge), most recently pinned on top — sorting is
  client-side (`chat-organize.ts` `sortPinnedFirst`, applied after
  `mergeRecents` so server-only pinned chats float too) and the SQL list
  order stays pure recency, keeping cursor pagination untouched. Both verbs
  are optimistic + fire-and-forget (offline/local-only chats still work) and
  fail-closed 404 on foreign ids. Pure transitions in `chat-organize.ts`
  (CO.1–CO.5), store methods H.19–H.22, route C.11–C.14.
  **Share** (same day, owner picked the parent-gated model —
  `docs/2026-08-06_PRD_ShareConversation.md`): ⋮ → 🔗 Share opens the
  ShareChat sheet — parent PIN (same verify-pin → `ari_parent` cookie gate
  as publish) → a revocable 32-hex secret link to `/share/chat/<token>`, a
  TEXT-ONLY server-rendered transcript (game code is never executed there —
  games render as a "🎮 built a game here" chip), `noindex`, dead the moment
  the link is revoked or the chat deleted. Revoking needs no PIN (it only
  reduces exposure). Re-sharing after a revoke mints a fresh token; old
  links stay dead. Store H.23–H.26, route S.1–S.6 (403 without a parent
  session even for the owner).
- **Delete a chat** (2026-07-26, owner ask; now the ⋮ menu's Delete item —
  the ✕ itself is gone): in-row two-tap confirm
  ("Delete / Keep" — no browser popup). SOFT
  delete: `DELETE /api/chats/:id` stamps `deletedAt` and the chat leaves the
  account's VIEW (list + get filter on `deletedAt IS NULL`) — the row stays
  in the system (safety review, recoverability). Ownership fail-closed;
  a later write-through upsert from another device never resurrects it in
  the sidebar. Client transition is pure (`chat-delete.ts`); deleting the
  last chat lands on a fresh "New chat", never a blank screen. Deleting the
  actively-generating chat is blocked until the turn finishes
- **Resumable generations** (2026-07-13, TECH_DEBT #23 shipped): the server
  keeps each turn's finished reply in `turn_results` (24h TTL) keyed by the
  client's replyId — a dropped or stalled stream POLLS `/api/chat/result`
  (4s ticks, up to 4 minutes while the server says `running`) and applies the
  finished reply for free instead of paying for a re-generation. Also the
  heavy-load tactic: a slow-but-alive model gets minutes of patience instead
  of a 30s kill-and-rebill re-entering the same overloaded pool. Re-generation
  only on genuine server error / unknown turn
- **Hedged generation + escalating wait UX** (2026-07-13): a model that goes
  fully silent for 30s (no chunks, not even thoughts) gets a HEDGE — the next
  fallback-chain model races it in parallel; the first answer token wins and
  the loser is abandoned unconsumed (at most one hedge per turn — no
  thundering herd when Google is overloaded). If the loser had streamed a
  partial, the `restart` event wipes it. Meanwhile the kid's "Thinking…" line
  escalates honestly by elapsed time (`wait-line.ts`: 🧱 → "calling in a
  faster helper 🤖⚡" → 🔧 → 🦖) — never a frozen spinner. Env knob:
  `GEMINI_STALL_SWITCH_MS`
- **Tab-close recovery** (2026-07-13, made patient 2026-07-28): the device
  bookmarks its in-flight turn (`pending-turn.ts`); if the kid closes the tab,
  navigates away, or switches to another chat in a new tab mid-generation, the
  next app load collects the server-finished reply from `turn_results` into the
  waiting bubble and syncs it into durable history — the reply is part of the
  chat whenever the kid comes back (24h window, matching the server TTL).
  Because `/api/chat` finishes the turn with nobody listening, the returning
  app **waits for it** (`pollTurnOutcome`, minutes not seconds — a build takes
  1–3 min) and says so in the bubble ("Ari is still finishing this one — it'll
  pop in here"); the bookmark is released only once the turn is done, failed,
  or too old to still be real (`turn-recovery.ts`, `RECOVERY_MAX_AGE_MS`), so a
  reply that's still cooking is picked up by the visit after that. A turn also
  keeps writing into ITS OWN chat when the kid opens another one — including
  the server write-through — while the preview and thinking line stay with
  whatever chat is on screen (BUG-FIX-LOG 2026-07-28)
- **Live dictation** (2026-07-10): while the mic is on, words appear in the
  composer AS the kid speaks (interim results stream in, then firm up when
  the recognizer finalizes them — `composeDictation`/`splitSpeechResults` in
  `src/lib/speech-transcript.ts`). No punctuation: Web Speech emits none,
  and heuristics only punctuated pause boundaries (owner decision
  2026-07-10 — none beats inconsistent; a server STT, e.g. Gemini audio,
  is the upgrade path). The listening banner carries a **✅ Done —
  send it!** button; ~5s of silence nudges "All done? Tap ✅ Done to send"
  (closes the say-it-then-what loop). The box is read-only during dictation
  (⏸ Pause to edit); Enter/Done mid-speech sends everything shown and aborts
  the session so nothing re-appears as a stray draft. Session ends (silence
  timeout, browser hard cap, kid's stop) flush the pending interim, so long
  monologues keep every word
- **Device-aware mic recovery** (2026-07-20): when the mic can't listen, a
  card — not a one-line error — explains what's wrong for THIS device and
  browser and how to fix it: numbered settings steps (lock-icon site
  permission vs. macOS/Windows/iOS/Android system permission), a
  "👋 Ask a grown-up" chip on OS-level fixes, and always two exits — **Try
  again** (re-checks and restarts) and **I'll type instead**. A pre-ask
  coach primes the browser's permission prompt so kids don't reflexively
  dismiss it (`src/lib/mic-recovery.ts`, `src/lib/platform.ts`,
  `MicRecoveryCard.tsx`; PRD §5a)
- **Anchor scroll** (2026-07-09, Gemini behaviour): on send (and regenerate) the
  child's request pins to the TOP of the view and the reply streams in below —
  the screen never chases a long code stream (replaced stick-to-bottom).
  Switching chats still opens at the latest messages
- **Picture upload** (2026-07-09): the + button accepts images (and the camera on
  mobile) so kids can give visual context — e.g. a screenshot of a broken game.
  Client downscales to ≤1024px JPEG (`Composer.tsx`); the server validates with
  deterministic fail-closed guards (mime allow-list png/jpeg/webp + size cap,
  `src/lib/image-attachment.ts`) and sends it as a real image part on the final
  turn (`buildChatContents`). Owner decision: content judged by Gemini's built-in
  strict safety in-generation (no separate pre-check call). **Session memory**
  (same day): the latest picture per conversation is kept in React state and
  re-sent with follow-ups and regenerate, so "now fix the jumping too" still
  sees the screenshot; a new upload replaces it. Never stored in localStorage
  (quota) — lost on reload until server-side history (TECH_DEBT #26)
- **Deterministic file-open** (2026-07-26, BUG-FIX-LOG): uploading a complete
  HTML document and asking to open it ("open the file", "run it", or nothing
  at all) opens the file in the preview **byte-for-byte with no model call**
  — a local assistant line confirms it, and the file becomes the chat's
  current game so the normal patch-edit flow continues from it. A real
  change request typed with the upload opens the file first, then sends the
  ask as an ordinary edit against the OPENED game (the model never rebuilds
  the raw file — that path hallucinated additions). Fragments/scripts (.js,
  partial HTML) still fold into the prompt as before (`src/lib/file-open.ts`,
  pure + 9 tests; `ChatPanel.container.tsx` executes the plan)
- **Builder mode** (2026-07-09, middle-path thinking): game-BUILD turns (message
  says "game", or the chat already has a game artifact) run with a bounded
  thinking budget + extended output (24576 tokens) — the two config gaps
  that made gemini.google.com's Flash write better game code than ours. Ordinary
  chat keeps thinking 0 / instant first token. Budget lowered 2048 → 1024
  (2026-07-11): vague asks burned the whole budget weighing interpretations
  before any code streamed; paired with a commit-to-one-interpretation line in
  `CHILD_SYSTEM_PROMPT` ("pick one fun, concrete interpretation … do not list
  options"). Env-tunable
  (`GEMINI_BUILDER_THINKING_BUDGET`, `GEMINI_BUILDER_MAX_OUTPUT_TOKENS`);
  client stall guard is phase-aware (90s to first token, then 30s between
  tokens) so the silent thinking phase isn't treated as a dead stream
  (`src/lib/builder-mode.ts`)
- **Live planning line** (2026-07-11): builder turns request thought summaries
  (`includeThoughts`); the route filters each through `kidThoughtLine`
  (`src/lib/kid-thought.ts` — fail-closed: no code, no markdown, ≤120 chars)
  and streams `{type:"thinking"}` events; the chat shows the latest line in
  place of the static "Thinking… 💭" so planning feels alive. Thoughts are
  never part of the answer text
- **Build progress narration** (2026-07-31,
  docs/2026-07-31_PRD_BuildProgressNarration.md): the same filtered thought
  line gets a keyword-derived emoji (`buildStepLabel`, `src/lib/build-narration.ts`
  — 🦖 dinosaur, 🏟️ stadium/field, 🏏 bat/swing, 🔊 sound, 🏆 score, generic 🛠️
  fallback) instead of a plain 💭 caption, so the chat's thinking line AND the
  preview's "Making ..." strip over the game the kid is STILL PLAYING both
  narrate what's actually happening right now, in lockstep. Falls back to the
  existing `waitLine()`/static strip whenever there's no thought text — never
  worse than before. **2026-07-31 fix:** small edits often produce a thought
  too short/code-like for `kidThoughtLine()` to pass, so the preview strip
  fell back to a generic caption with no emoji at all; `buildUpdatingLine()`
  now falls back to the kid's OWN request text (always available, already
  past the input gate) instead, still emoji-tagged
- **Gemini model-fallback chain** (2026-07-11; cost-aware reorder 2026-07-13,
  BUG-FIX-LOG + PRD-MODEL-FALLBACK): capacity errors (503 "high demand"/429),
  transient 5xx/network drops, and retired model ids walk
  `GEMINI_FALLBACK_MODELS` (owner chain: 3-flash-preview primary →
  2.5-flash → 3.5-flash → 2.5-flash-lite, one attempt each) before erroring;
  real defects throw at once. 3-flash-preview is Gemini-3-class game code at
  $0.5/$3 per M vs 3.5-flash's $1.5/$9 — the premium model is the deep
  fallback, not the default. Kids get a game from a sibling model instead of
  "Oops! Something went wrong." during spikes. Originally `replyStream()`
  only (the main streamed answer); `GeminiChatModel.reply()` (the
  patch-mismatch full-regeneration safety net) and `.repair()` (self-healing
  preview) called the primary model directly with no fallback of their own —
  a gap BUG-FIX-LOG 2026-07-18 closed via a shared `oneShotWithFallback()`, so
  all three entry points now recover the same way
- **Starter chips** (2026-07-08): 4 random game prompts from a 500-strong pool
  (`src/lib/game-suggestions.ts`, 10 mechanics × 50 themes) — fresh picks every
  load and every new chat, so kids don't see the same four twice
- **Next-ask chips** (2026-07-28, flag OFF by default —
  `NEXT_PUBLIC_ENABLE_KID_HINTS`, `docs/2026-07-27_PRD_KidHintsAndNextBestAsk.md`):
  after a build OR an edit, 3 "what to try next" chips — 2 concrete/buildable,
  1 open-ended "what if" imagination-spark — piggybacked on the SAME chat call
  via a trailing `NEXT_ASKS:` sentinel line the model appends and route.ts
  parses/strips server-side (`src/lib/next-ask-sentinel.ts`), so they're
  genuinely contextual to the game in front of the kid at near-zero added cost
  (no second API call). **Edit turns use their own prompt variant**
  (`NEXT_ASK_EDIT_PROMPT_SECTION`): one trailing line after the last
  `>>>>>>> REPLACE`, carving a single explicit exception out of
  `GAME_EDIT_PROMPT_SECTION`'s "nothing after the patch blocks" rule. That line
  is inert against the whole patch pipeline — `applyPatch` anchors on the
  SEARCH/REPLACE sigils and ignores other text, `editReplyProse` shows only
  what precedes the first block, and `streamingDisplayText` cuts at the first
  `<<<<` — all three asserted in `next-ask-sentinel.test.ts`, and a live 5-edit
  A/B measured identical patch compliance (5/5 clean both with and without).
  Falls back to a static local pool (`src/lib/tweak-suggestions.ts` +
  `src/lib/imagination-hints.ts`) whenever the model's line is missing or
  malformed. That pool holds "change THIS game" ideas, never
  `game-suggestions.ts`'s brand-new-game starters — serving those after an edit
  was a real reported bug (BUG-FIX-LOG 2026-07-28): unrelated to the game on
  screen, and tapping one abandons it. Chips are only ever attached when the
  turn produced a playable game — never under a refusal, clarification,
  off-topic reply, or new-game prompt
- Sandboxed HTML game artifacts the AI can build in-chat — Preview/Code tabs
  (code pane scrolls), download/copy; on mobile the panel is fullscreen with a
  "← Chat" back button, and any game message shows a "🎮 Open game" chip to
  reopen a closed preview
- **Full-screen preview** (2026-07-11, `docs/PRD-PREVIEW-PANE.md`): a ⤢ button
  in the pane header (desktop; Esc to exit) expands the 440px column to fill
  the screen — a CSS-only wrapper toggle (`panelShellClass`,
  `src/lib/preview-pane.ts`), so the running game, tab, and device choice
  survive expand/collapse untouched. Disabled while the verify cover is up
- **Old game stays playable during updates** (2026-07-11,
  `docs/PRD-PREVIEW-PANE.md`): while a new feature generates (send OR
  regenerate), the previous game keeps running in the pane under a
  "Making your update… you can keep playing this one! ✨" strip; the new
  version swaps in only on the stream's `done` (policy: `nextArtifact`,
  `src/lib/preview-pane.ts`; safety retract still blanks immediately).
  Shipped with two bug fixes (BUG-FIX-LOG 2026-07-11): verify no longer
  restarts on a new ask, and updated games reliably reach the iframe
  (`previewDocKey` round-collision fix)
- **Device preview** (2026-07-10): Fit · Laptop · Tablet · Phone pills in the
  preview bar simulate real viewports (1366×768 / 820×1180 / 390×844,
  `src/lib/device-preview.ts`) — the device box keeps its true CSS-pixel size
  and scales DOWN to fit the panel (never up), restyling the SAME iframe so
  the running game never reloads. Disabled while the verify cover is up
  (probes always measure at panel size); resets to Fit on each new game.
  **Rotate toggle (2026-07-16):** a ⟳ button appears next to Tablet/Phone
  (the only `orientable` presets — Laptop is already landscape, Fit has no
  fixed shape) swapping width/height via the pure `orientedSize()` function;
  resets to portrait on each new game alongside the Fit reset
- **🩹 Self-healing preview** (2026-07-10, platform
  `docs/PRD-SELF-HEALING-PREVIEW.md`): every generated game is verified BEHIND
  an opaque cover card before the kid's first look — structured error trap
  (message + stack), rAF counter, and silent-failure probes (loop-never-started,
  zero-size canvas, frozen canvas, occluded/dead Start button) run inside the
  sandboxed iframe and report via postMessage (`src/lib/preview-verify.ts`,
  `usePreviewVerify.ts`). A found failure is classified (§7 taxonomy) and sent
  to `/api/repair`, which asks Gemini for a MINIMAL SEARCH/REPLACE patch
  (`src/lib/repair-prompt.ts`) — max 2 attempts, 20s total wall clock, then the
  best version uncovers with a kid-facing question (never a stack trace).
  **Only hard-evidence codes may spend a repair call** (`REPAIRABLE_CODES`:
  thrown error, async init, 404'd resource, occluded Start); probe-inference
  reads (frozen canvas, no loop, dead flag) are telemetry-only pass-through —
  a live UAT falsely "repaired" a healthy game (BUG-FIX-LOG 2026-07-10). The
  state machine is the framework-free `preview-verify-controller.ts` (same
  bug: a React effect cancelled its own repair continuation).
  Repair tokens are recorded (kind:"repair") but EXEMPT from the guest gate.
  Kill switch: `NEXT_PUBLIC_PREVIEW_REPAIR=0` (instrument-only). Telemetry:
  `preview_verify` / `preview_repair` Mixpanel events (`src/lib/analytics.ts`).
  Title-screen guard: a running loop idling on its start screen is static by
  design — the probe clicks Start, re-samples pixels, and reloads the iframe
  after a probe-click clean so the kid still gets a pristine title screen
- **🩹 Patch-based feature edits** (2026-07-18, BUG-FIX-LOG class fix): a
  follow-up request on an already-good game ("add a medic kit") used to be
  answered by regenerating the ENTIRE file from conversation context, which
  could silently regress parts the kid never asked to change — a known LLM
  weak spot even under "keep the rest the same" framing. Reuses the
  self-healing flow's own minimal-patch contract (`applyPatch()`,
  `repair-prompt.ts`) for feature requests, not just bug fixes:
  `isGameEditTurn`/`currentGameHtml`/`GAME_EDIT_PROMPT_SECTION`
  (`src/lib/game-edit.ts`) route a follow-up turn on an existing game to a
  SEARCH/REPLACE-only system instruction instead of "write a full HTML
  document" — anything the model doesn't emit a hunk for survives
  byte-for-byte. Also cheaper and faster than before: a patch reply is a
  handful of lines instead of the 10-20K output tokens a full regeneration
  costs. Three outcomes after the model replies (`api/chat/route.ts`): a
  clean patch applies directly; an off-topic message (no patch attempted,
  the edit prompt is hedged for this) passes through as ordinary chat with
  the game untouched and no extra Gemini call wasted; a genuinely attempted
  but mismatched patch falls back to ONE full-regeneration call
  (`GeminiChatModel.reply({ forceFullRegen: true })`) so a real edit request
  never hits a dead end — the floor is "no worse than before this feature
  existed." `isGameEditTurn` is deliberately as over-inclusive as
  `isGameBuildTurn` itself (any message once a game exists) rather than
  guessing intent from keywords. **Hardened same-day** after live UAT
  ("multiple blocks and not working code"): a truncated/malformed patch
  attempt has no COMPLETE SEARCH/REPLACE match, so it used to fall into the
  same bucket as genuine off-topic chat and get shown to the kid as literal
  raw text; separately, `applyPatch`'s "model ignored the instruction"
  fallback trusted ANY fenced ```html block as a full replacement, so a
  partial "here's the changed part" snippet could silently become the whole
  game. Two new guards in `game-edit.ts` — `looksLikeAttemptedEdit()` (patch
  markers/fence/HTML traces mean a malformed attempt, not off-topic chat)
  and `looksLikeCompleteDocument()` (requires a real opening+closing
  `<html>`) — route both cases to the existing full-regeneration fallback
  instead, so a bad reply is retried once rather than ever shown raw or
  silently corrupting the game. **Hardened again same-day** (penguin-maze
  session, BUG-FIX-LOG 2026-07-18): measured against a real 18-turn edit
  session, the "model ignored the instruction, accept its full rewrite"
  path fired on 17 of 18 turns — so it no longer counts as silent success.
  A full-document reply on an edit turn now gets ONE hunks-only retry
  (`GeminiChatModel.strictEditRetry` + `GAME_EDIT_STRICT_RETRY_SECTION`,
  with a `NEEDS_FULL_REBUILD` honest-out); a clean retry patch wins,
  anything else accepts the rewrite but labels it honestly
  (`regenReplyProse`/`REBUILT_GAME_LINE` — never a bare "Added that!"-style
  line when the whole game was rebuilt, including on the fallback path). An
  identically re-sent child message (`isRepeatedRequest` +
  `REPEATED_REQUEST_SECTION`) tells the model its previous reply did NOT
  work and to change approach. And the whole feature has a kill switch:
  `GAME_EDIT_PATCH=off` (`patchEditsEnabled`, gated inside `isGameEditTurn`)
  restores exact pre-patch full-regeneration behavior in one env flip —
  the guaranteed rollback path
- **⏪ Continue from here** (2026-07-18): `currentGameHtml`/`findLastGameIndex`
  normally target the NEWEST game message in the conversation — there's no
  separate "which version is active" pointer anywhere. So when a later edit
  regresses a game, a kid/creator can click "Continue from here" on any
  earlier game message — a small muted text link below that message's "Open game"
  button (demoted from a same-styled side-by-side button 2026-07-24: two equal
  buttons confused kids about which to tap; Open game is now the one
  `.btn-primary`, the link sits under it with a text-presentation ↩︎ glyph,
  and the ⋯-menu tip moved below both) — to pin it (`Conversation.activeGameMessageId`,
  `chat-rewind.ts`) as the edit target for the NEXT turn only — non-destructive:
  nothing is deleted or reordered, the regressed later messages stay right
  where they are in the thread, visible and still playable via their own
  "Open game" button. A banner above the composer names the pin and offers
  Cancel; the pin auto-clears the instant that next turn is sent (`handleSend`
  reads then clears `activeGameMessageId`) — once the new reply lands it's
  the newest message again and ordinary "last game wins" behavior resumes on
  its own, no lingering state. The pin travels to the server as
  `activeGameMessageId` in the `/api/chat` body and is threaded through
  `trimHistory`/`isGameEditTurn`/`currentGameHtml` (each keeps its own
  override lookup, same "duplicated on purpose" pattern as the rest of this
  module pair) so the model's system instruction AND the post-stream patch
  target both resolve to the pinned version, not the newest one. Regenerating
  a reply that was itself generated from a pin (`ChatMessage.basedOnMessageId`)
  redoes against that SAME pinned version rather than falling back to
  whatever the regenerate history slice considers newest. E2E-pinned
  (`scripts/e2e-continue-from-here.mjs`) since the pin banner, DOM
  non-destruction, preview swap, and the actual outgoing request body need a
  real browser
- **🛠 Console (debug-only since 2026-07-10)**: the capture script injected into
  every game's iframe (before the game's own code runs) forwards
  `console.log/warn/error`, uncaught errors (now with filename/line/stack), and
  unhandled promise rejections (`src/lib/game-console.ts`). The Console tab is
  HIDDEN from kids (PRD G1 — errors feed the self-healing loop instead of a
  nine-year-old); grown-ups/devs re-enable it with
  `localStorage["kidgemini:debug"]="1"`
- **🚀 Put it in the Arcade** (2026-07-07): CTA under the preview publishes the
  game to games.ariantra.com — kid names it (live URL check + 🎲 ideas,
  optional checkbox to pick a different web address/slug than the display
  name), a grown-up approves with the FAMILY's 4-digit parent PIN (verified
  via `/api/parent/verify-pin` → parent-session cookie; the publish route
  checks the cookie's account MATCHES the SSO session, so a parent from
  another family can never approve — PRD-PARENT-AUTH-ALERT-SCOPING), then it
  goes live under the family's SSO account with auto-score/leaderboard/
  thumbnail included (`PublishToArcade.tsx` + `/api/arcade/publish` →
  platform partner bridge). **Every publish asks for the PIN, every time**
  (owner decision 2026-08-01) — the client always routes through the PIN step
  before publishing, regardless of any live Parent-area session.
  **One question per decision** (2026-07-24, BUG-FIX-LOG): the sheet opens on a
  skeleton ("Getting the launchpad ready… 🚀") while it checks whether the kid
  already has games, then commits ONCE — games → "What are we doing?", none →
  straight to naming. It used to open on the naming screen as a guess and
  correct itself, so a kid with existing games saw name → choose → name.
  Sequencing is pure + tested in `src/lib/publish-flow.ts`; a late or retried
  games-list response can never pull a kid out of naming, the PIN, or a
  running publish
- **✏️ Edit a launched game** (2026-07-24, platform PRD-STUDIO-CHAT-EDIT
  revised — Ari is the editor): Studio's per-game "Edit in Games-Lab" button
  arrives here as `/?edit=<slug>&chat=<chatId?>` (`/bible-teacher?…` for
  teacher games). Resolution (`lib/edit-entry.ts` + the container bootstrap,
  URL stripped on arrival — no re-run on reload): the game's ORIGINAL chat if
  it still exists (local cache → server history), else a fresh chat SEEDED
  with the live game's code via `GET /api/arcade/edit-source?slug=`
  (session-gated; fronts the platform's owner-checked `getCode`, which
  returns the archived bundle with all platform injections stripped). The
  seeded chat opens with the game already playing, a green "🔗 Editing X —
  publishing updates x.ariantra.com" banner, and `Conversation.editSlug`
  binding: the Publish button reads "Publish update" and skips the
  brand-new/update question (preset `updateTarget`; parent-PIN gate
  unchanged). Every publish forwards `chatId`, which the platform stamps as
  `Game.sourceChatId` — so legacy games self-heal into deep-linkable ones on
  their first republish. Failures are in-chat messages with a next step
  (signed-out / multi-file "re-upload in Studio" / deleted / admin-paused /
  network), never a blank screen, never a "coming soon" promise
- **Category + play-mode choice at publish** (2026-07-18, owner ask): the
  naming step now includes required category chips — since 2026-07-26 the
  LIVE list is fetched from `/api/arcade/categories` (an Ari server proxy of
  the platform's public `/api/categories`, so admin-added categories from
  /studio/admin appear here immediately; `GAME_CATEGORIES` in
  `src/lib/game-categories.ts` is only the offline fallback, and the proxy
  itself falls back to it on any failure — `sanitizeCategories`, GC.1-GC.5) —
  no more everything-lands-in-"Arcade". Games whose HTML carries the
  `USES_MULTIPLAYER` marker also get a "How is it played?" toggle (Single
  player / With friends 2–5; preselected to friends since that's what the
  kid built, defaults single everywhere else). The publish route forwards
  `seo.multiplayer: true` only when the kid chose multiplayer AND the marker
  exists (`route.test.ts` G.6–G.12) — choice alone would ship a dead lobby,
  marker alone would override the kid. Admins can recategorize any game
  later via the platform's admin console (`/studio/admin` category select →
  `set-category` action, built 2026-07-26). **'Arcade' retired 2026-07-26**
  (owner decision): dropped from `GAME_CATEGORIES` here and on the platform;
  a stale client sending it is treated as an unknown category (dropped, G.12).
  When the game carries the multiplayer marker, the naming step also shows an
  up-front chip — "👥 Multiplayer game — friends can join with a code!" —
  so the kid sees it before choosing play mode (owner ask 2026-07-26); the
  platform catalog badges these games the same way on their cards
- **🔄 Update mode**: when the kid already has games, the sheet ASKS first —
  "brand-new game" or "update one of mine" with a picker of their games
  (fetched via the partner `list` action, session-verified). Picking one
  skips naming and goes straight to the PIN with "this replaces the version
  that's already online" — same address, new version. Typing a name that
  matches their own game also flips to update (`mine` check). Fail-closed:
  ownership verified server-side on both the list and the publish
- **Copyright/trademark check** (2026-07-17, enforced platform-side —
  `../Ariantra-Platform/docs/FEATURES.md`'s Studio section,
  `copyright-policy.ts`): the live debounced name-availability check and
  the final publish both surface a match as a distinct `check.state ===
  "copyright"` (not lumped in with "taken"), with kid-friendly copy —
  "'{term}' belongs to a big company, not you — pick your OWN game name and
  it'll be even cooler! 🌟" — and the same clickable suggestion chips
  already used for a taken name, populated with alternatives close to what
  the kid typed (the trademarked word stripped out) that are confirmed both
  clean and available
- **🔗 Share card on publish success** (2026-07-17,
  `../Ariantra-Platform/docs/PRD-SHARING.md` Phase 1, S1 "I made this!"): the
  "done" step of `PublishToArcade.tsx` gets an editable message — templated
  from `data.credit` (name/age off the publish response) when opted in:
  "{name}, {age}, made a game. Actual playable game, in the browser, no
  download.\n{link}"; otherwise "I made a game! Play it here.\n{link}\n
  (Built it on Ariantra — kids make the games.)" — + WhatsApp/native-share/
  copy-link buttons — but only when the family's Sharing & Privacy is turned ON
  (`shareEnabled`, read straight off the publish response, no extra round
  trip — the platform's partner bridge now returns it alongside `url`/
  `version`). Off shows "🔒 Ask a grown-up to turn on sharing" linking to the
  Parent area instead of a dead-end share button. This IS the family's own
  voice pushing their kid's identity forward, so it stays gated — unlike a
  stranger just passing along a link (see the platform's `share-overlay.ts`
  and catalog `CatalogClient.tsx`, which never gate on this flag)
- **📤 "Share your child's games" (Parent area, S2 "parent pride push")**
  (2026-07-17): a STANDING card (not a one-time notification) listing every
  published game with its own Share button — parent-framed, third-person
  copy templated from `shareCredit`: "{name}, {age}, made a game. Actual
  playable game, in the browser, no download." when opted in, else "My kid
  made a game! Actual playable game, in the browser, no download." — same
  WhatsApp/native-share/copy-link channels as the kid's own card. Consent is
  account-level (Sharing & Privacy in the family profile applies to every
  game), so one `shareEnabled` flag from `/api/parent/games`'s `list` action
  (now also returned by the partner bridge, alongside the existing games
  array) gates the whole card; off shows a link to turn it on instead of
  per-row buttons. Same "family's own voice, stays gated" reasoning as the
  kid's own share card
- Copy rewrite (2026-07-17): the kid is the hook, not the platform — a named
  "a 10-year-old made this" beats any platform tagline, and "no download"
  removes WhatsApp's one real objection. There is no `ARIANTRA_TAGLINE`
  constant any more — the brand line lives only in each game's OG
  description (platform's `seo.ts`), which the link preview already
  carries; repeating it in the message text was doing the preview's job
  twice. Neither surface uses non-BMP emoji (🎮/👾/etc.) in message text —
  wa.me's own redirect to api.whatsapp.com corrupts them into the UTF-8
  replacement character (verified independent of this repo's code)
- **WhatsApp button opens the app directly** (2026-07-17, both share
  surfaces on this side): tries `whatsapp://send?text=` first (mobile app or
  WhatsApp Desktop, hands off immediately — no "select WhatsApp Web" step),
  falls back to `wa.me` only if the page is still visible ~1.2s later
- **🎮 Multiplayer generation + "🧪 Test link"** (2026-07-14,
  `../Ariantra-Platform/docs/PRD-MULTIPLAYER.md` Phase 4; button renamed from
  "🎮 Invite a friend to test" 2026-08-06 — owner UAT: "Invite" read like it
  starts a multiplayer session, when it actually mints a temporary
  try-before-publish link): asking
  for a 2-player/co-op/versus game conditionally teaches the model
  `Ariantra.broadcast()`/`onMessage()`/`onPlayers()` (never `host()`/`join()`
  — the platform's injected lobby overlay owns those) plus the
  `<!--USES_MULTIPLAYER-->` marker. A "🧪 Test link" button appears next to
  🚀 Arcade ONLY on games carrying that marker, and creates a real friend
  session before anything is published — no naming, no parent PIN, no `Game`
  record; the link expires in 2 hours (`InviteToTest.tsx` + `/api/arcade/
  test-link` → platform partner bridge's `createTestLink`, same shared-secret
  pattern as publish). A grown-up can turn "Play together" off per published
  game from the Parent area (🎮 Multiplayer card, `/api/parent/games` → the
  partner bridge's `toggleMultiplayer`, same PIN + ownership-match gate as
  publishing) — flipping it restamps the live game immediately.
  **Gap closure (2026-07-25, `../Ariantra-Platform/docs/PRD-MP-GAPS.md`):**
  the prompt now also teaches host-only `Ariantra.reportMatch()` at game over
  (never `submitScore()` in a multiplayer game — the platform suppresses
  auto-score during a match) and reconnect resilience (a non-host wifi blip
  self-heals for up to 60s; only `onRoomEnded`/`onConnectionLost` are
  terminal). The preview bundle (resynced) now ships the echo peer "Robo":
  ~1s after a game first touches a multiplayer API, a fake second player
  joins the roster, echoes `broadcast()`s back, and mirrors the kid's own
  `broadcastState()` a beat behind — so multiplayer games visibly work in
  the studio preview before a real friend is invited ("Robo copies your
  moves" toast keeps it honest)
- **⏳ Unified Idea Queue** (v2 2026-07-24, docs/PRD-IDEA-QUEUE-V2.md — supersedes
  the v1 typed-only queue AND the 🎒 Idea Bag): ONE visible line, per
  conversation, for every idea a kid has while Ari is busy. Typed ideas
  (composer, Enter/↑ while busy) join as numbered **`build`** rows — one row =
  one turn; ideas spoken over the preview via the 🎤 mic tab join as ✨
  **`tweak`** rows — consecutive tweaks compose into ONE bundled turn
  (`takeNextSend`), so five spoken thoughts never cost five rebuilds. The card
  sits above the composer ("⏳ Next up (n)", cap 5); rows edit in place
  (commit-on-change, so a drain can never send pre-edit text) and drop with ✕.
  Draining is fully automatic, one send unit per CLEAN finish; idle tweaks wait
  a 4s "settle" ("✨ Sending in a moment — keep talking!", with Send now ▶) so a
  kid mid-thought gets one bundle. Stops/failures freeze the line with a
  reasoned hold: "restored" (chat opened/reloaded with a line) clears on any
  kid action, "failed" clears ONLY on the explicit "Yes — keep going ▶" — a
  fresh message never silently resumes a frozen line. **In the preview** the
  line is mirrored (mobile + full screen, where the panel covers the chat): a
  ⏳ n chip (⏸ n in warn tint when held) in the header opens a bottom sheet
  with the same card — edit/drop/resume without leaving the game — and while a
  queued idea builds, the banner names it ("Making \"…\"") so the game swap on
  `done` is never silent. Refusals always say why and keep the text: a 6th
  typed idea, or an attachment while busy, is refused in the composer; a spoken
  tweak at the cap MERGES into a trailing tweak row (a mic user has no composer
  holding their words). The line rides on `Conversation.queuedIdeas`
  (localStorage + per-turn server write-through); v1 bag records migrate once
  into their chat's line as tweak rows
  (`src/lib/idea-queue.ts`, `src/lib/idea-migrate.ts`, `IdeaQueue.tsx`,
  `Composer.tsx`, `ArtifactFrame.tsx`, `ChatPanel.container.tsx`)
- **🎤 Idea Button** (2026-07-12, docs/PRD-IDEA-BUTTON.md; capture target since
  2026-07-24 = the Idea Queue above — the 🎒 Idea Bag and its ✨ button are
  RETIRED): an edge-docked mic tab over the game preview — the only capture
  path while the composer is hidden (⤢ full screen / mobile game screen).
  Click slides it out, second click listens (stray clicks near game controls
  are harmless; the tab drags up/down the edge); the game keeps running and
  keeps the keyboard. ✅ hands the transcript to the queue as a tweak row —
  capture never interrupts; the line drains itself. The listening bar shows
  what's already lined up, and a refused commit (line full of typed builds)
  keeps the transcript on screen and says why. Audio never recorded — the
  browser transcribes live; reuses `useSpeechInput`/`mic-errors` verbatim
  (`IdeaMicTab.tsx`, `src/lib/idea-mic.ts`).
  Wake-word invocation deliberately rejected (always-on mic = parent-trust +
  iOS reliability); revisit only with on-device keyword spotting / Gemini Live.
  **First-run coach** (2026-07-12): the very first playable preview dims and the
  tab introduces itself — wiggle + glow, speech bubble read ALOUD by the buddy
  voice (pre-readers), mini demo, "OK got it". Once per device; tapping the
  tab during the intro goes straight to listening; ONE wiggle-only re-nudge
  after 3 idea-less games, then silence forever (`src/lib/idea-coach.ts`,
  policy truth-table tested + `scripts/e2e-idea-coach.mjs` browser pins)
  **Fixed 2026-07-18 (BUG-FIX-LOG):** the mic tab/Idea Bag overlay was
  invisible on every ORDINARY game preview (default "fit"/real-device mode,
  not a Tablet/Phone/Laptop frame) — `ArtifactFrame.tsx`'s panel-size
  `ResizeObserver` only ran while a device frame was shown, but the overlay's
  width/height fall back to that SAME measured size whenever no frame is
  active, so it was permanently stuck at the initial `{0,0}`. The observer
  now runs in every device mode
- **↔ Pull-to-resize preview** (2026-07-12): the 440px desktop panel now has a
  drag handle on its left border (min 360px, max 70vw, width remembered in
  localStorage; keyboard ←/→ on the separator). CSS-var driven (`--panel-w`) so
  the running game's iframe never remounts (`PanelResizeHandle.tsx`,
  `clampPanelWidth` in `src/lib/preview-pane.ts`)
- Guest trial: chat free up to 10K tokens per device per rolling 2-day window
  (per-IP backstop at 2× so cookie-clearing doesn't reset it) → then a blocking "Please sign in to continue
  using Ari" wall → Ariantra SSO (Google or username/password)
- Signed-in: unlimited today; config-ready daily budget → upgrade paywall
  (`SIGNED_IN_DAILY_TOKEN_LIMIT` env knob, ships OFF)
- Recents sidebar, new-chat, **chat search** (2026-07-09): the sidebar 🔍 is an
  inline filter over titles AND message text (client-side, `src/lib/chat-search.ts`;
  game artifact HTML excluded to avoid noise matches), with match count and a
  friendly no-results state
- **Desktop sidebar collapse** (2026-07-17): a « / » toggle in the sidebar
  header shrinks it to an icon-only rail (`md:` only — the mobile drawer is
  already collapsible via open/close and always renders full), reclaiming
  width for chat/preview; state persists across reloads (`src/lib/sidebar-pane.ts`).
  Expanding scrolls the active chat back into view. A failed Recents fetch now
  shows a "Couldn't load your chats — tap to retry" row instead of silently
  looking empty (BUG-FIX-LOG 2026-07-17)
- **History trim** (2026-07-08, server-side): the model only sees the last 12
  messages and only the NEWEST game's code — older game versions collapse to
  a placeholder (each carried ~10-15K input tokens on every message of an
  iterating conversation). The newest game rides along even if it's older
  than the window, so "update my game" always has code to work from. The
  stored conversation/UI is untouched (`src/lib/history-trim.ts`)
- **Save & continue building** (2026-08-03,
  `docs/2026-08-01_PRD_SaveContinueBuilding.md`): a build/world game (a
  physics stacking tower, a "build your universe" world) can implement a
  small postMessage save contract (`<!--SUPPORTS_SAVE-->`) — the prompt
  clause is gated on build/world/inventory keywords or artifact evidence
  (`gates.save`, `catalog-gate.ts`), same shape as the 3D/audio gates.
  Reopening a chat whose game has a saved state shows a "Continue your
  build?" bar (Continue / Start fresh) above the preview; Continue injects
  `window.__ARIANTRA_INITIAL_STATE__` before the game's own script runs.
  While playing, the parent app asks the game for its state every 30s
  (`useGameSaveChannel`) and writes it to a dedicated `game_saves` table
  (one slot per message, capped at 1.5MB, server-debounced to one write per
  15s). **Now also carries over to published/Arcade games** (2026-08-04,
  same `gates.save`, `published-save-playbook.ts`, TECH_DEBT #27/#70):
  generated games ADDITIONALLY call `Ariantra.confirmResume()`/
  `Ariantra.autosave()` (`../Ariantra-Platform/src/sdk/ariantra-sdk.ts`) —
  the postMessage contract above only works inside this app's own sandboxed
  chat-preview iframe (nothing sends the request-save message once
  published), so the direct SDK calls are what make a published game's
  build/world state survive after publishing. Both mechanisms are taught
  together, never as a replacement for each other — the in-chat draft still
  needs the durable, server-side `game_saves` path the direct calls can't
  provide there (Ariantra-Platform's preview mock is memory-only)

## 3D games (2026-07-12 — Phase B of PRD-3D-GAMES-AND-ASSETS)
- The model MAY build genuinely 3D games (racing, flying, rolling-ball) with
  Three.js primitives instead of flat canvas: it opts in by emitting
  `<!--USES_THREE-->`, and the server splices in an import map pointing
  `three` at the immutable engine bundle on the shared asset host
  (`https://assets.ariantra.com/three.{hash}.js`, ~550 KB, cached a year
  across ALL games on every kid device). String-concat injection only —
  no file reads, no network on the box (`src/lib/assets/inject.ts`);
  injection failure serves the raw game (the preview can never be lost)
- The 3D prompt section (`src/lib/assets/prompt-catalog.ts`) teaches a
  curated import list (lockstep-tested against the vendored bundle) and
  enforces kid-hardware render budgets: `preserveDrawingBuffer: true` (the
  self-healing pixel probe reads blank without it — PRD §10b R1, proven in
  a real-browser harness), pixel ratio capped at 2, ambient + one
  directional light only, no shadows/post-processing, low poly. Sent only
  on game-BUILD turns (chit-chat pays zero extra tokens)
- **Which turns get the 3D section** — `catalogGates()`
  (`src/lib/assets/catalog-gate.ts`) decides from the child's own words, via
  the shared `THREE_ASK_RE` in `src/lib/builder-mode.ts`. It matches the
  spellings children actually use — `3d`, `3-d`, `3 d`, `three dimensional`,
  `3-dimensional` — and deliberately not `3-day` / `3 dogs` / `3ds max`. It is
  ONE definition shared with the build-turn gate; it was previously two
  separate copies of `/\b3d\b/i` that had drifted, and a child who wrote
  **"Make it 3-D"** matched neither, so a literal 3D request was built with none
  of the rules above (BUG-FIX-LOG 2026-08-09)
- **Pipeline-bypass guards** (`src/lib/assets/three-import-lint.ts`, wired into
  both gates in `api/chat/route.ts`). The gate predicts from the child's words;
  the MODEL decides independently whether to build in 3D, and the two can
  disagree — so the output is linted too, for three shapes that each kill a game
  before its first frame:
  - `unknownThreeImports` — a name the vendored bundle doesn't export
  - `externalScriptSrcs` — an off-origin `<script src>`; a game that loads
    three.js from a public CDN gets whatever version the model happened to
    name (r128 in the real case), and is a liveness dependency on someone
    else's uptime for a game we promise to keep forever
  - `danglingModuleSpecifiers` — a specifier for a file that will never exist
    (`./three.module.js`, `./main.js` — an invented multi-file layout)
  All three fold into ONE corrective retry naming the exact violation, never a
  second round. Patch turns are judged only on what the patch ADDED, so a
  stored game already carrying one stays editable. **Fails soft** — if the
  retry isn't clean the original is still served: visible and repairable beats
  dropped. Measured against every stored artifact: both dead games flagged,
  zero false positives on the working ones (61 of 64 three-using games follow
  the pipeline)
- 2D stays the default; unmarked games pass through byte-identical
- **2D→3D is a NEW game** (owner decision 2026-07-26, supersedes the in-place
  conversion rebuild of BUG-FIX-LOG 2026-07-23): asking an existing 2D game to
  "make it 3D" answers instantly (no model call, nothing billed) with an info
  panel — "3D means building a whole NEW game… you'll have TWO games!" — and
  ONE OK button. OK opens a fresh chat seeded with the 2D source
  (`threeDConversation`, not slug-bound) and builds the 3D version there with
  `forceRebuild`; the 2D game survives untouched in its own chat, so the child
  knowingly ends up with two games. The new chat is titled **`3D - <name>`**
  (owner ask 2026-07-26: prefix, so the badge survives sidebar truncation and
  the pair sorts together). Route guard: `api/chat/route.ts` §1b;
  tests D3.1-D3.3, C.R, EE.9
- **Library models** (Phase C, filled to 20 in Phase F): games can name
  curated CC0 models (`<!--USES_MODELS: car, dino-->`) and load them with
  the injected `loadModel(name)` helper — fail-soft (null on any failure,
  game keeps running), meshopt-compressed GLBs (≤ 100 KB each), first-load
  transfer capped at 2 MB at inject time. **`modelSize(name)`** (2026-08-08)
  answers a model's real measured metres `{x, y, z}` *before* it loads, from
  the injected `window.AR_SIZES` table (also stamped on the loaded object as
  `userData.arSize`); `null` for the 17 skinned models, which carry no
  trustworthy rest-pose bbox. This is what lets a game lay road/track tiles
  edge-to-edge instead of guessing a spacing — see BUG-FIX-LOG 2026-08-08.
  **`modelAxis(name)`** (2026-08-08) gives a path piece's run axis, because the
  two road kits genuinely disagree (city runs X, racing runs Z) and a 1x1 square
  tile's footprint cannot reveal it. **`modelJoins(name)` + `rotateToJoin(name,
  from, to)`** (2026-08-09, `window.AR_EDGES`) give which EDGES a tile's road
  actually reaches, its carriageway width in metres, and the `rotation.y` that
  swings one edge onto another — `modelAxis()` answers `'none'` for every
  corner, which is true and no help at all in placing one, so before this a
  generated track guessed corner rotations and never closed (BUG-FIX-LOG
  2026-08-09). Unlike `pathAxis` these are MEASURED, from a top-down render of
  the published bytes (`scripts/render-assets.mjs`) — the geometry cannot answer
  it, since these tiles are flat slabs with the road painted into the texture.
  Asset fitness (`src/lib/assets/fitness.ts`, `scripts/asset-fitness-sweep.mjs`)
  runs those measurements as rules — *can this tile tile?* — blocking in the
  vendor pipeline and as a standing worklist over the whole library.
  **`scripts/verify-game-html.mjs`** (2026-08-09) loads a generated game in a
  REAL browser via iframe `srcdoc` and reports console/page errors, failed asset
  fetches, and whether `loadModel` and a canvas actually exist at runtime — the
  check every string-assertion test in the repo is blind to, and the one that
  found the import-map ordering outage. **`scripts/golden-prompts.mjs`** runs a
  small fixed set of child-shaped prompts (`golden/prompts.json`) through the
  real generation path and then through that verifier, on demand only. The
  prompt's model catalog is
  generated from the manifest, so names can never drift; it ends with
  per-genre hints (people/crowd, racing, platformer, space, animals,
  castle, city, forest, water, food) filtered to what's being taught. **56 models**:
  vehicles (car, police, firetruck, taxi, ambulance, tractor), space
  (rocket, spaceship, ufo, helicopter, alien), animals (dog, cat, fish,
  bird, chicken, bat, dolphin, bee, shark, dino), places (tower,
  skyscraper, house, bridge), nature (tree, pine, rock, mushroom),
  items (coin, star, key, chest, heart, gem, bomb, spring, flag, barrel,
  crate, sword, catapult), food (burger, ice_cream, donut, apple), plus
  hero, robot, ghost, boat
- **People** (2026-07-19): six animated humans — man, woman, girl,
  scientist, police_officer, pirate (Kenney Blocky Characters, CC0,
  ~55–64 KB each). One shared rig, every model carries the same 12 clips:
  idle, walk, sprint, sit, drive, die, pick-up, emote-yes/no,
  interact-right/left, static — so kids' games get crowds that cheer
  (emote-yes), walk, run (sprint) and sit in stadiums (pair with
  grandstand). The prompt teaches the clip names when a people model is
  taught, plus the crowd rule: call `loadModel` per person (cached
  download), never `.clone()` a skinned character (shared-skeleton bug)
- **Sports & battle tops** (2026-07-26, `docs/2026-07-26_PRD_SportsAssets.md`):
  soccer_ball, soccer_goal, battle_top, blade_top (first-party CC0 —
  authored in-repo by `scripts/author-first-party-models.mjs` because no
  CC0 third-party soccer/spinning-top models exist and Beyblade meshes are
  branded), plus footballer / footballer_blue (Kenney character-b
  re-skinned into red/blue kits — same shared rig and clips as the other
  people, PLUS the two attack-kick clips, so a football game can actually
  kick). New `sports` genre + trigger (soccer, football, goal, penalty,
  beyblade, spinning top…). **Sports playbook** (same day, owner ask): the
  catalog also teaches the RULES so games behave like the sport — team
  sports get score-in-the-opponent's-goal + restart, one-chaser +
  formation AI (never the ball-swarm), a keeper clamped to the goal
  mouth, and kick-as-impulse with friction; duel games (air hockey,
  battle tops) get paddle-half clamps and spin/velocity decay. Static and
  manifest-derived, so prompt caching is unaffected (~250 tokens)
- **Military: tanks, armored vehicles, fortifications** (2026-07-29,
  `docs/2026-07-29_PRD_MilitaryAssets.md`): 16 CC0 models — four visibly
  distinct tanks (tank / tank_desert / tank_toy / tank_rusty, so "my tank vs
  the enemy tank" has real sides), armored_truck, armored_pickup, turret,
  turret_cannon, cannon, sandbags, sandbags_small, barricade, bunker,
  watchtower, radar, chain_fence. New `military` genre + trigger (army, tank,
  soldier, war, battle, base, turret, defence…). **Scope: vehicles and
  fortifications only** — no soldier characters and no hand-held weapons, even
  though CC0 versions exist; the batch sits beside the fantasy-siege set
  (catapult, trebuchet) and inside the register `safety.config.ts` already
  allows for cartoon tank games. A test enforces that scope. "soldier"/"gun"
  Per-model byte budget raised 100 KB → 150 KB (owner decision) so the
  realistic tanks could ship
- **Military batch 2: soldiers + hand-held weapons** (2026-07-29, same PRD
  §3e; owner reversed batch 1's scope — "it is all part of kids games these
  days"): 20 more CC0 models — `soldier`, `hazmat`, rifle / assault_rifle /
  sniper_rifle / shotgun / submachine_gun / pistol / revolver, rocket_launcher
  / grenade_launcher / bazooka, grenade / landmine / bullets, flare_gun, plus
  sci-fi laser_gun / space_rifle / space_pistol and a shield. **No
  safety-policy change was needed** — `safety.config.ts` already treats
  fictional weapons in a child's own game as not-dangerous and cartoon
  video-game action as not-violence. The two soldiers are a **different rig**
  from the Kenney people (Quaternius `CharacterArmature`: Idle, Run, Run_Gun,
  Idle_Shoot, Jump, Wave, Death), so they get their own prompt clause that
  teaches only the clips ALL of them have — `soldier` has no walk clip. The
  catalog also tells the model weapons are separate objects to parent onto a
  soldier
- **Movement playbook + physics engine** (2026-07-29,
  `docs/2026-07-29_PRD_Physics.md`; owner ask: "it don't follow driving
  physics, rotating physics, jumping"): the prompt previously taught NOTHING
  about motion outside the football playbook, so every car/jump/spin was
  reinvented per turn. `PHYSICS_PROMPT_SECTION` now teaches delta-time
  integration (with the `Math.min(delta, 0.05)` clamp that stops a
  backgrounded tab teleporting the player through the floor), jump feel
  (coyote time + variable height + faster fall), driving as speed+heading with
  **turn rate scaled by speed** so a parked car can't pirouette, angular
  velocity with decay, roll tied to `distance / radius`, and restitution with a
  rest threshold. PLUS a real rigid-body engine — **cannon-es**, MIT, vendored
  as the second immutable engine (`physics.{hash}.js`, 82 KB): a game opts in
  with `<!--USES_PHYSICS-->` and imports from `cannon-es`, guarded by
  `cannon-import-lint.ts`. The engine clause renders ONLY when the manifest
  carries the bundle (never teach a dead import) and tells the model NOT to use
  it for ordinary platformers/runners/driving, where the playbook maths feels
  better and costs nothing. rapier3d was measured and rejected: 1.53 MB WASM
  breaches the 2 MB first-load cap, and it is Apache-2.0
- **Cricket set** (2026-07-29, `docs/2026-07-29_PRD_CricketAssets.md`):
  cricket_bat, cricket_ball, wicket (stumps + bails as one model), cricket_pitch,
  sight_screen, cricketer, trophy. **First-party CC0 — there was nothing to
  download:** a 14-term sweep found ZERO CC0 cricket assets and only two CC-BY
  bats at any license, so even relaxing the licence policy would not have
  helped. Authored to regulation dimensions at 1 unit = 1 m (bat 0.85 m, ball
  74 mm, wicket 0.2286 m wide, pitch 10 ft × 22 yd) so scenes look right without
  the model guessing scale. The cricketer is Kenney character-b re-skinned into
  whites — same mesh and rig, so it inherits the full blocky-character clip set.
  Cricket words (cricket, wicket, stumps, batsman, bowler, innings, googly…)
  added to the sports trigger; the CC0 baseball bats were deliberately NOT
  reused, since a round bat reads as the wrong sport
- **Animals, hills & snow/ski set** (2026-08-09,
  `docs/2026-08-09_PRD_AnimalsSnowSkiAssets.md`; owner ask: "more CC0 3D meshes
  … on animals like crocodile, elephats, deer, monkey, lion, tiger and also
  hills and snow mountains, sking environment"): **58 models** (53 CC0 + 5 CC-BY animals with the automatic credit chip).
  Vendored (Quaternius/Kenney): deer, stag, wolf, fox, horse, donkey, zebra,
  panda, snake, frog — all with real Idle/Walk/Gallop clips — plus mountain,
  mountain_small, mountain_range, snow_pine, snow_birch, snow_dead_tree,
  snow_bush, snow_rock, ice_block, snowboard, and the hill kit (hill_slope,
  hill_block, hill_corner, cliff). **First-party CC0** for everything with no
  CC0 source anywhere — crocodile, elephant, lion, tiger, monkey (poly.pizza's
  whole big-cat/jungle shelf is CC-BY; Kenney's animal packs are 2D sprites)
  and every piece of ski gear: skis, ski_poles, sled, chairlift,
  ski_lift_tower, slalom_gate, igloo, snowman, plus a real 28 m `snow_mountain`
  (the CC0 `mountain` is a 1.9 m grey rock with a white fleck). The owner chose authoring over
  the CC-BY unlock, so the batch adds **no new credit-chip models**. New
  **snow / skiing** genre (its own, not a corner of `nature` — a ski game must
  not drag in cactus and palm trees). Animals are authored at real scale, so
  the elephant is 6.1 m and towers over the 2 m cars.
  **Rivers + rain forest** (same session): Kenney river tiles (straight/bend/
  corner/cross/split/end/rocks, `pathAxis` declared - this kit runs along Z,
  the roads kit along X), waterfall, waterfall_top, lily_pad, log, tree_stump;
  plus jungle_tree, palm_tree_tall, savanna_tree, bamboo, bamboo_short, vines,
  big_leaf_plant, jungle_grass. **The five headline animals are CC-BY
  downloads, not the authored meshes** - the authored ones were reversed the
  same day ("pathetic" was the owner's word, and the render comparison agreed);
  games using them carry the automatic credit chip.
  **The batch also fixed a year-old pipeline bug** (`docs/BUG-FIX-LOG.md`):
  dropped animation clips were never actually dropped — `Animation.dispose()`
  leaves its samplers' accessors alive, so every animated model shipped
  carrying every clip it ever had. Deer 261 KB → 113 KB. The whole animated
  animal shelf had been rejected as "mesh-heavy" for a year on that number
- **Indian games set** (2026-07-30, `docs/2026-07-30_PRD_IndianGamesAssets.md`;
  owner ask: games popular with Indian kids 7-14): kabaddi (kabaddi_mat,
  kabaddi_player), carrom (carrom_board, carrom_striker, carrom_coin_white/
  black, carrom_queen), kho-kho (kho_kho_pole ×2 per field, kho_kho_lane_field,
  kho_kho_player), badminton (badminton_racket, shuttlecock, badminton_net),
  ludo (ludo_board, ludo_dice, ludo_pawn_red/green/yellow/blue), and marbles
  (marble, marble_blue, marble_green) — 22 models total. **First-party CC0 —
  same wall as soccer/cricket:** a poly.pizza (CC0-filter)/Kenney/Quaternius
  sweep found zero usable models for any of the six. Lives in its OWN new
  genre `indian_games` (not folded into `sports` — carrom/ludo/marbles are
  tabletop games, not sports in the cricket/football sense). Authored to
  regulation dimensions at 1 unit = 1 m (kabaddi mat 10×13 m, carrom board
  0.82 m incl. frame, badminton racket 0.67 m / hoop ≤0.22 m wide, kho-kho pole
  1.23 m, marble 16 mm) — a render-pass bounding-box check caught the racket
  under length + over width and the pole over height on the first pass, same
  class of defect the cricket batch's wicket-gap bug was. kabaddi_player and
  kho_kho_player are Kenney character-b re-skinned into a NEW "kabaddi" kit
  (`retexture-footballer.py`) — same mesh and rig, so they inherit the full
  blocky-character clip set; both sports deliberately share the one kit
  (PRD: same sleeveless-vest silhouette, no separate kit needed). Coin/pawn/
  marble colour variants are one geometry re-colored, matching the existing
  footballer/blade_top pattern. Catalog token ceiling raised 1750 → 1900 as
  the documented revisit (measured, not assumed) — see prompt-catalog.test.ts
- **Frame governor + stop-when-hidden** (2026-07-29, PRD §6b; from an hour of
  real play that heated the owner's machine): every 3D game now pauses when the
  page is hidden and is capped to 60fps. Shipped TWICE on purpose — as playbook
  rules for new games, and as an injected governor (`frameGovernor()` →
  `ensureAssetRuntime`) because edits are minimal patches and would never
  retrofit an existing game's loop. The governor reaches every game on every
  preview render, including HTML stored long before it existed; measured on a
  real game, hidden-tab rendering went 53.3 fps → 0. Published arcade games are
  static S3 HTML and cannot be reached. Also new: a rule against letting dead
  objects fill a spawn cap, after a tank game deadlocked into an empty arena
- **Preview Perf Panel** (2026-07-30,
  `docs/2026-07-30_PRD_PreviewPerfPanel.md`; owner ask: a 3D cricket game with
  24 separately-animated characters heated up a laptop, with no way to tell
  which part was responsible short of reading the generated source by hand):
  a debug-only “⚡ Perf” tab, gated by the SAME `kidgemini:debug` flag as the
  Console tab, next to it. Shows overall FPS + draw calls, then every
  currently-loaded model ranked highest-load-first — instance count, triangle
  count, animated yes/no, and a green/yellow/red chip. **Load, not "cost"**
  (owner correction — "cost" implies money): `triangles × live instances ×
  an animated multiplier`. Same instrument-the-shared-runtime pattern as the
  frame governor: `loadModel()` (`runtime-helpers.ts`) records each named
  model's triangle count + live instances into `window.__arPerf`; the
  vendored three.js bundle (`scripts/vendor-three.mjs`) additively wraps
  `WebGLRenderer` (registers the instance so `.info.render` is readable) and
  `AnimationMixer` (marks which roots are animated) — both wraps call
  straight through to the real class, zero behavior change. A new injected
  probe (`perf-probe.ts`, same shape as the self-heal verify probe) samples
  once a second and `postMessage`s a snapshot; `usePerfProbe.ts` holds the
  latest one. Reaches games that already exist the same way the governor
  does — `ensureAssetRuntime` re-floors every preview render. Never
  kid-facing; a model with zero live (in-scene) instances is never shown.
- **🐢 "Running slow" banner** (2026-07-30 same-day addendum,
  `docs/2026-07-30_PRD_PreviewPerfPanel.md` §7; owner correction — kids are
  the actual developers of these games too, and need something, just not the
  admin panel above): a SECOND, always-visible surface (no debug flag),
  floating top-center over the live preview (mic/help tabs dock at the right
  edge, so it never collides). Shows only the symptom a kid already
  recognizes — "This game is running slow" — never triangles/instances/model
  names. Appears only after `SUSTAINED_LOW_SAMPLES` (5) CONSECUTIVE low-fps
  perf-probe samples (`src/lib/slowdown-nudge.ts`, pure + unit-tested state
  machine), never on one dipped frame. Its "Make it faster" button sends the
  REAL technical hint (highest-`load` model from the same `PerfSnapshot`, its
  instance count and animated state) into the ordinary chat pipeline
  (`ChatPanel.container.tsx`'s `handleSend`, same as a next-ask hint chip)
  via `ArtifactFrame`'s new `onFixSlowdown` prop — the kid never sees that
  string. Tapping it starts a 45s cooldown so a fix already in flight isn't
  re-nagged every second. **Now also server-visible** (2026-08-04, PRD §8):
  the instant the banner shows, a fire-and-forget `POST /api/perf/slow-game`
  logs `[perf] slow game detected: ...` (docKey, fps, heaviest model)
  server-side (`lib/perf-report.ts`) — `pm2 logs kidgemini | grep '\[perf\]'`
  on the box now surfaces a real slowdown as it happens, not just inside the
  one kid's browser tab that hit it.
- **Retrieval-lite selection** (PRD §14, `src/lib/assets/model-select.ts`):
  the library is unbounded but each build-turn prompt teaches ≤ 30 models,
  picked by cheap regex — the iterated game's own USES_MODELS markers,
  names the kid said, genre keyword matches, then a core set. Scales to
  hundreds of models at flat prompt cost; libraries ≤ 30 skip selection
- **Library audio** (Phase D): any game (2D or 3D) can name curated CC0
  sounds (`<!--USES_AUDIO: coin_pickup, bg_loop_upbeat-->`) — 10 SFX + 2
  music loops + a win jingle. Injected helpers: `playSound(name)` (Web-Audio
  one-shot) and `playMusic(name)` (gapless loop via silence-trimmed
  loopStart/loopEnd on an AudioBufferSourceNode — MP3's encoder gap never
  reaches the kid's ears; PRD §10b R2). Fail-soft: a broken sound is a
  silent one. Budgets at inject time: audio ≤ 500 KB/game, first load ≤ 2 MB
- **Tiered catalog unlock** (Phase E, `src/lib/assets/catalog-gate.ts`):
  catalogs ride only game-BUILD turns (chit-chat pays zero catalog tokens),
  and on the free tier each unlocks by keyword — "3d" opens the 3D + model
  catalog, "sound/music/song/sfx" opens the audio catalog — scanned across
  the message, prior child messages, AND prior artifacts' `USES_*` markers
  (iterating on a 3D game keeps 3D unlocked). No keyword → exactly today's
  inline-content prompt; nothing is ever refused. Paid = both always-on,
  one-line flip when entitlement (TECH_DEBT #11) lands
- **"Game Stuff" gallery** (`/assets`, §9b): kid-facing cards for every
  manifest asset — live 3D turntables rendered with the engine FROM the
  asset host (permanent contract dogfood), playable sound cards,
  trigger-phrase teaching with a read-aloud button per card, friendly
  empty state, JSON-LD + sitemap

## Analytics (Mixpanel — 2026-07-06)
- Privacy-hardened snippet in the root layout (`src/lib/mixpanel-snippet.ts`,
  same source as the platform's): autocapture + 100% session recording, but
  recordings mask ALL text (chat included) and block iframes (game artifacts);
  no input values, no element text, no IPs, never `identify()` — guarded by
  `mixpanel-snippet.test.ts`

## Safety (the core value)
- **Posture (owner decision 2026-07-09):** the Flash-Lite classifier is no
  longer in the chat path — it retracted harmless games (chess). Safety on
  `/api/chat` is now: instant deterministic input rules (block + parent alert)
  → Gemini built-in safety thresholds (real-time blocking while streaming)
  → an explicit child-safety system instruction (age 7–14, "be careful in the
  way you speak / cautious about safety"). **Games are never blocked or
  retracted.** Locked by route.test.ts R.1 + gemini.prompt.test.ts.
  (`/api/safety`, the extension endpoint, still uses the classifier.)
- **Game-action exemption** (owner decision 2026-07-06): classic game genres —
  space shooters, sword adventures, cartoon battles — are allowed (system
  prompt welcomes them, cartoonish/bloodless only; Gemini DANGEROUS_CONTENT
  at MEDIUM). Locked by safety.config.test.ts
- Parent alerting: input-rule flags recorded with severity/action/reason
- **Parent dashboard** (`/parent`) — per-FAMILY auth (2026-07-10,
  PRD-PARENT-AUTH-ALERT-SCOPING Phase 1): each signed-in family sets its own
  4-digit PIN (hashed scrypt in SQLite `parent_auth`; set/reset requires a
  FRESH SSO login ≤5 min — a kid on a parent's old session can't set it).
  Verify is POST-body only, throttled (5 tries → 15-min lock, repeat within
  24h → 1h) and issues an HttpOnly parent-session cookie that gates
  `/api/alerts`. **Scoped to the visit, not a rolling TTL** (owner decision
  2026-08-01): the cookie is cleared the moment the Parent area is left
  (`/api/parent/session/clear`, called on page unmount and on `pagehide` via
  `sendBeacon`), so leaving and coming back always re-prompts for the PIN.
  Guests see sign-up copy, never a PIN form (D3). The old
  shared `PARENT_PIN` env var (with its `"1234"` fallback!) is DELETED.
  **Forgot-PIN recovery** (2026-07-27, BUG-FIX-LOG): "Forgot your PIN?" on
  the verify screen, and a dedicated recovery callout the moment a lockout
  hits (reset isn't blocked by the lockout — only re-guessing is), both
  go straight to the set/reset screen — no waiting out a lock. Set/reset
  itself requires a 6-digit code emailed to the account's own address
  (`POST /api/parent/pin-otp/request` → `parent-pin-otp.ts`, 10-min expiry,
  5-attempt budget, 60s resend cooldown, 5/24h send cap) — this REPLACED the
  original fresh-SSO-login gate (2026-07-27, same day, round two): a live
  Google session or a saved password on a shared family device satisfied
  freshness with no secret only the parent has, so a locked-out kid could
  reset the PIN themselves. Ari has no SMTP of its own — the code is emailed
  via a platform bridge (`parent-pin-otp-bridge.ts` → the platform's
  `x-admin-secret`-gated `/api/studio/partner/parent-pin-otp`, same pattern
  as the Sparks bridge), reusing the platform's real `EmailSender`.
  INTERIM: alerts are still a global list until Phase 2 child scoping
  (platform TECH_DEBT #32)
- Kids' transcripts stay local (SQLite) — never in git, never read by tooling

## Limits & admin
- Per-IP rate limiting with daily windows + 3-strike escalation
- Usage/cost tracking per user/model — admin dashboard (`/admin`):
  today / this-week / this-month / this-year / all-time rollup cards (IST
  calendar, Monday weeks), all 4 billed token types (prompt / output /
  thinking / cached — real Gemini `usageMetadata` since 2026-07-14, not
  chars÷4), cost in ₹ (env `USD_INR_RATE`) + USD, daily totals + top spender
  per day, per-user and per-location breakdowns, raw log. OPERATOR-ONLY since
  2026-07-10: gated by `ADMIN_SECRET` (POST body, timing-safe compare, 503
  when unset — never open), independent of the parent PIN, and no longer
  linked from the kid UI. NOTE: the gate tallies still use the estimate
  columns by design (docs/COST_TOKEN_BUDGET.md)
- Unique-visitor panel (2026-07-14): per period, distinct signed-in accounts ·
  guest cookies (browsers) · guest IP+user-agent pairs (devices) · an
  estimated-people total (accounts + min of the two guest signals — cookie
  clears inflate browsers, shared wifi deflates devices). The raw User-Agent
  header is recorded per usage event (privacy.html "Technical usage data" row;
  no fingerprinting) and shown as a coarse "Chrome · Windows" Device column in
  the request log
- Returning-users list (2026-07-14): accounts AND guest cookies active on 2+
  distinct IST days (all time), with days active / requests / first / last
  seen — same-day repeats count once; guest streaks undercount across cookie
  clears

## Community Help 🆘 (2026-07-28 — PRD-COMMUNITY-HELP Phases 1–2)

A stuck child can reach a real person, and browse ready-made asks. Both ship
**behind flags that default OFF** (`NEXT_PUBLIC_ENABLE_HELP_BUTTON`, and
separately `NEXT_PUBLIC_ENABLE_HELP_NUDGE`): turning the first one on creates an
obligation — once a child can ask a person for help, someone has to be there.

**Phase 1 — the 🆘 queue**
- A 🆘 tab docked on the game preview under the 🎤 Idea tab and deliberately
  quieter than it (`HelpTab.tsx`; the Idea Button stays the happy path). Same
  dock grammar: circular icon, always-visible caption, no hover-only tooltip.
- Tap → six **picture reasons**, each with 🔊 read-aloud, so a pre-reader can
  file unassisted: 🕹️ won't move · ⬜ blank · 🎨 looks wrong · 🔇 no sound ·
  🤷 don't know what to ask (→ the Phase 2 gallery, not the queue) · 🎤
  something else (reuses the Idea Button's speech path). Structured
  `reasonCode`s, never free prose — the histogram is what writes the gallery's
  backlog.
- The ticket carries the reason, an optional transcript, the bounded
  `buildErrorReport()` diagnosis, the verify verdict and an artifact
  *reference*. **Never the game's source, never the chat history.** Guests can
  file (the guest wall must not block asking for help).
- **A reply can take up to 16 hours**, so the promise is "by tomorrow" (never
  "soon") and the wait state is rebuilt from `GET /api/help` on every boot: a
  persistent "⏳ Waiting for a helper" strip, a 📬 banner when an answer landed
  *while the kid was away*, and a cross-chat tap-through when it landed on a
  different game. One constant drives both the promise and the queue's
  colouring (`src/lib/help-sla.ts`, `HELP_REPLY_TARGET_HOURS = 16`).
- Proactive nudge (own flag) once the repair loop has genuinely given up, or
  three asks in ~5 minutes changed nothing on screen (`src/lib/stuck-signal.ts`).
  One offer per game, dismissible, never modal.
- Operator queue at **`/admin/help`** — `ADMIN_SECRET` in a POST body,
  timing-safe, 503 when unset (same shape as `/admin`). Oldest-first, waiting
  time colour-coded against the 16h target. **Canned replies first**
  (`src/lib/help-canned.ts`); free text is the marked exception, is screened by
  the same deterministic safety rules as chat input (profanity *and* PII, so no
  helper hands a child contact details), and is refused entirely for guest
  tickets (no parent to mirror it to). "Load game source" is a separate action
  that writes a `help_audit` row.
- The reply is **one-way**: 👍 That helped closes, 😕 Still stuck reopens, and
  there is no text field — no channel to an adult is ever created. The card
  reads "A helper at Ariantra" with its own visual treatment: never styled as
  Ari, never as another kid.
- **Every reply writes exactly one `ParentAlert`** (`origin: "system"`), so a
  parent can read every word an adult said to their child without opting in —
  plus a **🆘 Help requests tab** in `/parent` showing each thread in full.

**Phase 2 — the 📚 Help Gallery (`/help`)**
- Team-authored cards (`src/lib/help-cards.ts`) — zero user content, therefore
  zero runtime moderation, which is what makes this phase cheap.
- Every card ends in one tap: **✨ Ask Ari this** hands the card's prompt back
  through `help-ask.ts` and sends it via the normal `handleSend` → `/api/chat`
  path. Nothing bypasses safety; nothing is generated server-side.
- 🔊 on every card, SSR-readable content, a skeleton on nav (`loading.tsx`).

**Not built, on purpose:** Phase 3 (kid↔kid community) stays deferred behind the
PRD's six gates, and nothing in the UI hints at it — no "coming soon", no empty
social tab.

## Sparks ⚡ (metered currency — Ari side, 2026-07-25)

The PLATFORM owns the ledger (platform repo `docs/PRD-SPARKS.md`); Ari reports
usage and renders what comes back via `src/lib/sparks-bridge.ts` (same
server-to-server contract as `arcade-partner.ts`).

- **Metering**: every signed-in turn's real usage (winner + `kind:"fallback"`
  losers, with Ari's own `costUsd`) bills the platform ledger fire-and-forget
  from `api/chat/route.ts` (`billTurnSparks`) — guests unbilled (no account),
  safety calls never billed (our overhead, not the child's).
- **3D pricing (2026-08-08)**: `billTurnSparks` reports `is3D: gates.three`
  (the same `catalogGates()` predicate that gates the 3D asset catalog) on
  every debit, billing 3D builds AND edits at the platform's 3D rate —
  correctly re-detecting an edit on an EXISTING 3D game from its prior
  artifact's markers, not just the turn's message text. See
  `docs/PRD-3D-GAMES-AND-ASSETS.md`'s 3D pricing amendment.
- **Kid wallet `/wallet`** (`WalletPanel`, nav tab "Sparks ⚡"): celebration-
  first — games built, ⚡ EARNED, friends joined, credits-only history,
  referral code, coupon entry. NO deductions/balance/rupees (owner decision
  2026-07-25: celebrate up-numbers; a draining meter is anxiety). Gauge is
  quiet when healthy, gentle nudge when the platform says low.
- **Parent card** (Parent tab, `SparksParentCard`): the PRECISION — exact
  balance, ₹ value, full statement incl. spends (tokens + ₹ each), and the
  parent-only social-share reward submit (Twitter/Instagram, once per
  game+platform; kids never touch social surfaces).
- **Used since last recharge (2026-08-09)**: above the statement, one line
  answering the question the list never did — added, used (in ⚡ and ₹), how
  many builds it bought, and what's left, measured from the most recent CREDIT
  of any kind (`src/lib/sparks-statement.ts`, pure + tested). "Recharge" is not
  purchase-only on purpose: every balance to date arrived as `admin_grant`. With
  no credit in the statement it says "since this account started" rather than
  showing a total without its window.
- **Low balance**: the PLATFORM emails the parent (throttled 1/3 days) —
  kids are never dunned.
- **Publish celebration card** (closure §4, 2026-07-26): first publish's done
  screen shows "+N ⚡ for publishing!" — the amount read from the wallet
  credits feed (`src/lib/publish-celebration.ts`, pure + tested; wired in
  `PublishToArcade.tsx`). No card on republish (reward is once per game) or if
  the feed is unavailable — Sparks never wobble the publish flow.

## Billing (`/upgrade`, `/pay`) — Sparks packs (Phase 5, 2026-07-27)

- **Parent PIN gate on purchase (owner ask 2026-08-09)**: `POST /api/billing/order`
  refuses with 403 `parent_pin_required` when the family has a PIN and the
  request carries no valid `ari_parent` proof for THAT account; `/upgrade` shows
  a PIN step and resumes the same pack. Enforced server-side — the endpoint is
  callable directly, so a browser-only prompt would guard nothing. A family with
  **no** PIN set keeps buying as before (rule in `src/lib/parent-purchase-gate.ts`,
  reasoning in `docs/BUG-FIX-LOG.md` 2026-08-09).
- Razorpay one-time payments: pack cards, order creation, checkout — same
  rails as before, now selling `SPARK_PACKS` instead of yearly-access plans
- Webhook with signature verification + idempotency (each event processed once)
- A verified payment credits the platform Sparks ledger via a new `purchase`
  action on `/api/studio/partner/sparks` (server-to-server, `playerId`
  captured at order time — see `docs/BUG-FIX-LOG.md` 2026-07-27). No
  time-based entitlement anymore: `periodEndsAt` is always `null`; Sparks
  metering (`SparksService.canStart`/`debitUsage`) is the real usage gate.
- NOT linked from the kid UI (2026-07-11, still true): the sidebar's "Go
  premium" tab was removed — Sparks are sold on ariantra.com's pricing page,
  which links to `/upgrade`. Since 2026-08-06 the PIN-gated Parent area's
  Sparks Management tab carries a "⚡ Buy Sparks" CTA to `/upgrade`
  (`SparksParentCard.tsx`, guarded by `sparks-parent-buy-cta.test.ts`) — the
  kid-facing sidebar still never links it (`sidebar-no-premium.test.ts`).
  Guarded by `src/components/sidebar-no-premium.test.ts`
- Packs (2026-08-01, down to 2 tiers from the 2026-07-27 three-tier ladder):
  `pack500` / `pack1000` (₹500/₹1000 → 50,000/1,00,000 ⚡, same flat rate — 1
  Spark = 1 paisa for both, no bonus tier) in `src/lib/billing.config.ts`,
  pinned by `billing.config.test.ts` — the keys are a public contract with the
  "Ariantra AI" marketing repo's pricing cards (a separate static-site repo,
  update BOTH in the same change), which deep-link to `/upgrade?plan=<key>`;
  after sign-in (param survives the Auth.js round-trip) Checkout auto-opens
  for that pack — repeatable, no "already paid" gate, since packs are
  top-ups, not a single active plan (`upgrade-deeplink.test.ts`)

## Ariantra integration
- Shared Ariantra header on every page (`ArNav`): Home · Games · Games-Lab ·
  Studio — pixel-identical with the platform via the generated brand CSS
  (local copy, `npm run sync:brand`). "Ari" is the in-app AI-buddy persona
  (chat identity, unchanged); "Games-Lab" is the nav/domain name
- Co-hosted on the Ariantra EC2 box at `games-lab.ariantra.com` (:3001
  behind Caddy — the CANONICAL host as of 2026-07-17, later same day; the
  legacy `ari.ariantra.com` and `kidgemini.ariantra.com` hosts still
  resolve during the transition)
- One-command deploy: `npm run deploy` (rsync + pm2, SQLite kept on a persistent path)
