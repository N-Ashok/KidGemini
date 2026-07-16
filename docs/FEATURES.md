# KidGemini — Features (one-pager)

What the app does today. Product intent: `PRD.md`; system map: `ARCHITECTURE.md`.

## Parent area (`/parent`, PIN-gated)
- **Family profile signpost** (2026-07-13): a card linking to the Studio's
  Creator Profile deep link (`studio.ariantra.com/studio?profile=1`) — the
  ONE place parent/child details are collected (encrypted platform-side).
  KidGemini deliberately hosts no second form; SSO makes the hop seamless
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
  chats on the first visit after the update. Ownership fail-closed at the SQL
  layer (`/api/chats*`, `SqliteChatHistoryStore`); write-through happens once
  per finished turn, never per streamed token
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
- **Tab-close recovery** (2026-07-13): the device bookmarks its in-flight turn
  (`pending-turn.ts`); if the tab closes mid-generation, the next app load
  collects the server-finished reply from `turn_results` into the waiting
  bubble and syncs it into durable history — the reply is part of the chat
  whenever the kid comes back (24h window, matching the server TTL)
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
- **Gemini model-fallback chain** (2026-07-11; cost-aware reorder 2026-07-13,
  BUG-FIX-LOG + PRD-MODEL-FALLBACK): capacity errors (503 "high demand"/429),
  transient 5xx/network drops, and retired model ids walk
  `GEMINI_FALLBACK_MODELS` (owner chain: 3-flash-preview primary →
  2.5-flash → 3.5-flash → 2.5-flash-lite, one attempt each) before erroring;
  real defects throw at once. 3-flash-preview is Gemini-3-class game code at
  $0.5/$3 per M vs 3.5-flash's $1.5/$9 — the premium model is the deep
  fallback, not the default. Kids get a game from a sibling model instead of
  "Oops! Something went wrong." during spikes
- **Starter chips** (2026-07-08): 4 random game prompts from a 500-strong pool
  (`src/lib/game-suggestions.ts`, 10 mechanics × 50 themes) — fresh picks every
  load and every new chat, so kids don't see the same four twice
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
  (probes always measure at panel size); resets to Fit on each new game
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
- **🛠 Console (debug-only since 2026-07-10)**: the capture script injected into
  every game's iframe (before the game's own code runs) forwards
  `console.log/warn/error`, uncaught errors (now with filename/line/stack), and
  unhandled promise rejections (`src/lib/game-console.ts`). The Console tab is
  HIDDEN from kids (PRD G1 — errors feed the self-healing loop instead of a
  nine-year-old); grown-ups/devs re-enable it with
  `localStorage["kidgemini:debug"]="1"`
- **🚀 Put it in the Arcade** (2026-07-07): CTA under the preview publishes the
  game to games.ariantra.com — kid names it (live URL check + 🎲 ideas), a
  grown-up approves with the FAMILY's 4-digit parent PIN (verified via
  `/api/parent/verify-pin` → 30-min parent-session cookie; the publish route
  checks the cookie's account MATCHES the SSO session, so a parent from
  another family can never approve — PRD-PARENT-AUTH-ALERT-SCOPING), then it
  goes live under the family's SSO account with auto-score/leaderboard/
  thumbnail included (`PublishToArcade.tsx` + `/api/arcade/publish` →
  platform partner bridge). A parent verified in the last 30 min skips the
  PIN prompt entirely
- **🔄 Update mode**: when the kid already has games, the sheet ASKS first —
  "brand-new game" or "update one of mine" with a picker of their games
  (fetched via the partner `list` action, session-verified). Picking one
  skips naming and goes straight to the PIN with "this replaces the version
  that's already online" — same address, new version. Typing a name that
  matches their own game also flips to update (`mine` check). Fail-closed:
  ownership verified server-side on both the list and the publish
- **🎮 Multiplayer generation + "Invite a friend to test"**
  (2026-07-14, `../Ariantra-Platform/docs/PRD-MULTIPLAYER.md` Phase 4): asking
  for a 2-player/co-op/versus game conditionally teaches the model
  `Ariantra.broadcast()`/`onMessage()`/`onPlayers()` (never `host()`/`join()`
  — the platform's injected lobby overlay owns those) plus the
  `<!--USES_MULTIPLAYER-->` marker. A "🎮 Invite" button appears next to
  🚀 Arcade ONLY on games carrying that marker, and creates a real friend
  session before anything is published — no naming, no parent PIN, no `Game`
  record; the link expires in 2 hours (`InviteToTest.tsx` + `/api/arcade/
  test-link` → platform partner bridge's `createTestLink`, same shared-secret
  pattern as publish). A grown-up can turn "Play together" off per published
  game from the Parent area (🎮 Multiplayer card, `/api/parent/games` → the
  partner bridge's `toggleMultiplayer`, same PIN + ownership-match gate as
  publishing) — flipping it restamps the live game immediately
- **🎤 Idea Button + 🎒 Idea Bag** (2026-07-12, docs/PRD-IDEA-BUTTON.md): an
  edge-docked mic tab over the game preview — the only capture path while the
  composer is hidden (⤢ full screen / mobile game screen). Click slides it out,
  second click listens (stray clicks near game controls are harmless; the tab
  drags up/down the edge); the game keeps running and keeps the keyboard.
  Spoken thoughts collect in the Idea Bag (chip + badge, bottom-left) —
  capture never triggers a generation. The bag panel reads ideas aloud (🔊,
  pre-readers) and "✨ Make my game better!" bundles ALL ideas into ONE visible
  chat message (🎒-labeled bubble) through the normal /api/chat loop; ideas
  flip to `sent` only on a successful `done` — failures keep them bagged.
  Text-only records in localStorage (`kidgemini:ideas:v1`, audio never
  recorded); reuses `useSpeechInput`/`mic-errors` verbatim
  (`IdeaMicTab.tsx`, `IdeaBag.tsx`, `src/lib/idea-bag.ts`, `src/lib/idea-mic.ts`).
  Wake-word invocation deliberately rejected (always-on mic = parent-trust +
  iOS reliability); revisit only with on-device keyword spotting / Gemini Live.
  **2026-07-15 UAT polish:** a corner ✕ (top-right of the listening bar) is
  now the standard "just close this" affordance — same effect as 🗑️ Never
  mind (discards the in-progress draft only, keeps whatever's already
  bagged); "Done" dropped its ✕ icon in favor of 🏁 (an X read as
  "cancel/discard," not "successfully finished"); the listening bar now
  shows a compact, scrollable preview of already-saved ideas so a kid
  mid-capture doesn't have to leave the bar to check what they've said —
  the full editable list still lives in the Idea Bag panel.
  **First-run coach** (same day): the very first playable preview dims and the
  tab introduces itself — wiggle + glow, speech bubble read ALOUD by the buddy
  voice (pre-readers), mini demo, "OK got it". Once per device; tapping the
  tab during the intro goes straight to listening; ONE wiggle-only re-nudge
  after 3 idea-less games, then silence forever (`src/lib/idea-coach.ts`,
  policy truth-table tested + `scripts/e2e-idea-coach.mjs` browser pins)
- **↔ Pull-to-resize preview** (2026-07-12): the 440px desktop panel now has a
  drag handle on its left border (min 360px, max 70vw, width remembered in
  localStorage; keyboard ←/→ on the separator). CSS-var driven (`--panel-w`) so
  the running game's iframe never remounts (`PanelResizeHandle.tsx`,
  `clampPanelWidth` in `src/lib/preview-pane.ts`)
- Guest trial: chat free up to 10K tokens per device per rolling 2-day window
  (per-IP backstop at 2× so cookie-clearing doesn't reset it) → then a blocking "Please sign in to continue
  using KidGemini" wall → Ariantra SSO (Google or username/password)
- Signed-in: unlimited today; config-ready daily budget → upgrade paywall
  (`SIGNED_IN_DAILY_TOKEN_LIMIT` env knob, ships OFF)
- Recents sidebar, new-chat, **chat search** (2026-07-09): the sidebar 🔍 is an
  inline filter over titles AND message text (client-side, `src/lib/chat-search.ts`;
  game artifact HTML excluded to avoid noise matches), with match count and a
  friendly no-results state
- **History trim** (2026-07-08, server-side): the model only sees the last 12
  messages and only the NEWEST game's code — older game versions collapse to
  a placeholder (each carried ~10-15K input tokens on every message of an
  iterating conversation). The newest game rides along even if it's older
  than the window, so "update my game" always has code to work from. The
  stored conversation/UI is untouched (`src/lib/history-trim.ts`)

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
- 2D stays the default; unmarked games pass through byte-identical
- **Library models** (Phase C, filled to 20 in Phase F): games can name
  curated CC0 models (`<!--USES_MODELS: car, dino-->`) and load them with
  the injected `loadModel(name)` helper — fail-soft (null on any failure,
  game keeps running), meshopt-compressed GLBs (≤ 100 KB each), first-load
  transfer capped at 2 MB at inject time. The prompt's model catalog is
  generated from the manifest, so names can never drift; it ends with
  per-genre hints (racing, platformer, space, animals, castle, city,
  forest, water, food) filtered to what's being taught. **50 models**:
  vehicles (car, police, firetruck, taxi, ambulance, tractor), space
  (rocket, spaceship, ufo, helicopter, alien), animals (dog, cat, fish,
  bird, chicken, bat, dolphin, bee, shark, dino), places (tower,
  skyscraper, house, bridge), nature (tree, pine, rock, mushroom),
  items (coin, star, key, chest, heart, gem, bomb, spring, flag, barrel,
  crate, sword, catapult), food (burger, ice_cream, donut, apple), plus
  hero, robot, ghost, boat
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
  24h → 1h) and issues a 30-min HttpOnly parent-session cookie that gates
  `/api/alerts`. Guests see sign-up copy, never a PIN form (D3). The old
  shared `PARENT_PIN` env var (with its `"1234"` fallback!) is DELETED.
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

## Billing (`/upgrade`)
- Razorpay one-time payments: plan cards, order creation, checkout
- Webhook with signature verification + idempotency (each event processed once)
- Rails-only for now: paid rows stamp `periodEndsAt`; nothing gated on it yet
- NOT linked from the kid UI (2026-07-11): the sidebar's "Go premium" tab was
  removed — plans are sold on ariantra.com (Explorer ₹1,200/yr · Assisted
  Starter ₹3,990/4 classes · Assisted Pro ₹10,000/8 classes). `/upgrade` stays
  reachable by direct link only. Guarded by
  `src/components/sidebar-no-premium.test.ts`
- Plans (2026-07-11): `explorer` / `assisted4` / `assisted8` in
  `src/lib/billing.config.ts`, pinned by `billing.config.test.ts` — the keys are
  a public contract with ariantra.com's pricing cards, which deep-link to
  `/upgrade?plan=<key>`; after sign-in (param survives the Auth.js round-trip)
  Checkout auto-opens for that plan unless the account already has an active
  one (`upgrade-deeplink.test.ts`)

## Ariantra integration
- Shared Ariantra header on every page (`ArNav`): Home · Games · KidGemini · Studio
  — pixel-identical with the platform via the generated brand CSS (local copy,
  `npm run sync:brand`)
- Co-hosted on the Ariantra EC2 box at `kidgemini.ariantra.com` (:3001 behind Caddy)
- One-command deploy: `npm run deploy` (rsync + pm2, SQLite kept on a persistent path)
