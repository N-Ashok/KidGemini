# KidGemini — Features (one-pager)

What the app does today. Product intent: `PRD.md`; system map: `ARCHITECTURE.md`.

## Chat (home `/`)
- Gemini-powered kids chat: text + voice (TTS playback, regenerate last answer)
- Sandboxed HTML game artifacts the AI can build in-chat — Preview/Code tabs
  (code pane scrolls), download/copy; on mobile the panel is fullscreen with a
  "← Chat" back button, and any game message shows a "🎮 Open game" chip to
  reopen a closed preview
- **🛠 Console tab** (2026-07-08): a capture script is injected into every
  game's iframe (before the game's own code runs) that forwards
  `console.log/warn/error`, uncaught errors, and unhandled promise rejections
  to the Console tab — a red badge shows the error count, and the panel
  auto-opens the first time a game throws, so a broken game shows WHY instead
  of a blank frozen canvas (`src/lib/game-console.ts`)
- **Optional 3D graphics** (2026-07-08): the model can build a game with real
  3D (Three.js primitives + lighting) instead of flat 2D canvas by emitting a
  marker comment; the platform then bakes a self-contained, tree-shaken
  Three.js bundle into that game's HTML (`src/lib/three-vendor.ts` +
  `scripts/vendor-three.mjs`) — plain 2D games stay untouched/small, even
  once published as a static file. A curated 3D model library (named assets
  like "fox"/"car") is future work, not built yet
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
- Recents sidebar, new-chat
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
- Server-enforced safety gate on every message (separate Gemini safety model)
- **Game-action exemption** (owner decision 2026-07-06): classic game genres —
  space shooters, sword adventures, cartoon battles — are allowed (system
  prompt welcomes them, cartoonish/bloodless only; Gemini DANGEROUS_CONTENT
  at MEDIUM; classifier judges only graphic/realistic violence + REAL-WORLD
  dangerous acts). Verified live: "shooting game with laser gun" → full game;
  "make a real gun at home" → hard_block. Locked by safety.config.test.ts
- Parent alerting: flagged interactions recorded with severity/action/reason
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
- **Mobile app-like nav** (2026-07-08): fixed bottom tab bar — Chat · Arcade ·
  Parent — replaces the hamburger on phones (same `.ar-tabbar` CSS the
  platform uses, kidgemini-specific tabs); desktop nav is unchanged
- Co-hosted on the Ariantra EC2 box at `kidgemini.ariantra.com` (:3001 behind Caddy)
- One-command deploy: `npm run deploy` (rsync + pm2, SQLite kept on a persistent path)
