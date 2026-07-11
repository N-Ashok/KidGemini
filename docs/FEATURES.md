# KidGemini — Features (one-pager)

What the app does today. Product intent: `PRD.md`; system map: `ARCHITECTURE.md`.

## Chat (home `/`)
- Gemini-powered kids chat: text + voice (TTS playback, regenerate last answer)
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
- Usage/cost tracking per user/model (tokens, USD) — admin dashboard (`/admin`):
  daily totals + top spender per day, per-user and per-location breakdowns, raw
  log. OPERATOR-ONLY since 2026-07-10: gated by `ADMIN_SECRET` (POST body,
  timing-safe compare, 503 when unset — never open), independent of the parent
  PIN, and no longer linked from the kid UI

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
