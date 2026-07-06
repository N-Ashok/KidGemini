# KidGemini — Features (one-pager)

What the app does today. Product intent: `PRD.md`; system map: `ARCHITECTURE.md`.

## Chat (home `/`)
- Gemini-powered kids chat: text + voice (TTS playback, regenerate last answer)
- Sandboxed HTML game artifacts the AI can build in-chat — Preview/Code tabs
  (code pane scrolls), download/copy; on mobile the panel is fullscreen with a
  "← Chat" back button, and any game message shows a "🎮 Open game" chip to
  reopen a closed preview
- Guest trial: chat free up to 10K tokens per device per rolling 2-day window
  (per-IP backstop at 2× so cookie-clearing doesn't reset it) → then a blocking "Please sign in to continue
  using KidGemini" wall → Ariantra SSO (Google or username/password)
- Signed-in: unlimited today; config-ready daily budget → upgrade paywall
  (`SIGNED_IN_DAILY_TOKEN_LIMIT` env knob, ships OFF)
- Recents sidebar, new-chat

## Analytics (Mixpanel — 2026-07-06)
- Privacy-hardened snippet in the root layout (`src/lib/mixpanel-snippet.ts`,
  same source as the platform's): autocapture + 100% session recording, but
  recordings mask ALL text (chat included) and block iframes (game artifacts);
  no input values, no element text, no IPs, never `identify()` — guarded by
  `mixpanel-snippet.test.ts`

## Safety (the core value)
- Server-enforced safety gate on every message (separate Gemini safety model)
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
- Co-hosted on the Ariantra EC2 box at `kidgemini.ariantra.com` (:3001 behind Caddy)
- One-command deploy: `npm run deploy` (rsync + pm2, SQLite kept on a persistent path)
