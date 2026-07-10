# KidGemini — Features (one-pager)

What the app does today. Product intent: `PRD.md`; system map: `ARCHITECTURE.md`.

## Chat (home `/`)
- Gemini-powered kids chat: text + voice (TTS playback, regenerate last answer)
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
  thinking budget (2048) + extended output (24576 tokens) — the two config gaps
  that made gemini.google.com's Flash write better game code than ours. Ordinary
  chat keeps thinking 0 / instant first token. Env-tunable
  (`GEMINI_BUILDER_THINKING_BUDGET`, `GEMINI_BUILDER_MAX_OUTPUT_TOKENS`);
  client stall guard is phase-aware (90s to first token, then 30s between
  tokens) so the silent thinking phase isn't treated as a dead stream
  (`src/lib/builder-mode.ts`)
- **Starter chips** (2026-07-08): 4 random game prompts from a 500-strong pool
  (`src/lib/game-suggestions.ts`, 10 mechanics × 50 themes) — fresh picks every
  load and every new chat, so kids don't see the same four twice
- Sandboxed HTML game artifacts the AI can build in-chat — Preview/Code tabs
  (code pane scrolls), download/copy; on mobile the panel is fullscreen with a
  "← Chat" back button, and any game message shows a "🎮 Open game" chip to
  reopen a closed preview
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
  grown-up approves with the parent PIN, then it goes live under the family's
  SSO account with auto-score/leaderboard/thumbnail included
  (`PublishToArcade.tsx` + `/api/arcade/publish` → platform partner bridge)
- **🔄 Update mode**: when the kid already has games, the sheet ASKS first —
  "brand-new game" or "update one of mine" with a picker of their games
  (fetched via the partner `list` action, session-verified). Picking one
  skips naming and goes straight to the PIN with "this replaces the version
  that's already online" — same address, new version. Typing a name that
  matches their own game also flips to update (`mine` check). Fail-closed:
  ownership verified server-side on both the list and the publish
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
- Parent dashboard (`/parent`, PIN-gated): review alerts
- Kids' transcripts stay local (SQLite) — never in git, never read by tooling

## Limits & admin
- Per-IP rate limiting with daily windows + 3-strike escalation
- Usage/cost tracking per user/model (tokens, USD) — admin dashboard (`/admin`):
  daily totals + top spender per day, per-user and per-location breakdowns, raw log

## Billing (`/upgrade`)
- Razorpay one-time payments: plan cards, order creation, checkout
- Webhook with signature verification + idempotency (each event processed once)
- Rails-only for now: paid rows stamp `periodEndsAt`; nothing gated on it yet

## Ariantra integration
- Shared Ariantra header on every page (`ArNav`): Home · Games · KidGemini · Studio
  — pixel-identical with the platform via the generated brand CSS (local copy,
  `npm run sync:brand`)
- Co-hosted on the Ariantra EC2 box at `kidgemini.ariantra.com` (:3001 behind Caddy)
- One-command deploy: `npm run deploy` (rsync + pm2, SQLite kept on a persistent path)
