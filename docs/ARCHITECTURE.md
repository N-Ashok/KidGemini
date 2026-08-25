# Ari (formerly KidGemini) Architecture

One-page system map. Build rules: `../CLAUDE.md`; product: `PRD.md`;
scaling constraints: `SCALABILITY_ISSUES.md`.

## Shape

Next.js 14 (App Router, TypeScript strict) — frontend + secure backend in one
repo. All AI + safety + billing logic is server-side; the browser never sees
secrets or the raw Gemini API.

```
Browser ── pages: / (chat) · /help · /parent · /admin · /admin/help · /upgrade
   │
   ▼ API routes (runtime: nodejs)
/api/chat      → history trim (fixed placeholders, hysteresis window 12+6, lib/history-trim.ts;
                   current game source rides the FINAL user turn — 2026-08-25 PRD_EditTurnCost)
                 → input rules (deterministic, lib/safety.rules.ts)
                 → chat (Gemini chat model: built-in safety thresholds +
                   child-safety system prompt; no output monitor — 2026-07-09)
                   Transport is switchable: GEMINI_BACKEND=studio (default) |
                   vertex → AI Studio or Vertex AI express, one shared client
                   builder (lib/google-backend.ts) so generation and the safety
                   classifier can never land on different backends. Models,
                   thresholds and the fallback chain are identical on both —
                   see 2026-08-12_PRD_VertexBackendAndDeepSeek.md
/api/safety    → standalone safety checks (Flash-Lite classifier)
/api/alerts    → parent alert feed (PIN-gated)
/api/usage     → usage/cost admin feed
/api/help      → 🆘 Community Help: a stuck child files a picture-reason ticket
                 (guests allowed; identity server-resolved; game source never
                 accepted) and reads their OWN tickets + replies, with the
                 answering admin's identity stripped. /api/help/feedback is the
                 only thing a child sends back: 👍 closes, 😕 reopens, no text
/api/parent/help → the same tickets for the PIN-verified parent, in full — the
                 accountability surface (replies also write a ParentAlert)
/api/admin/help → operator queue: list (oldest-first, 16h target) · reply
                 (canned-first; free text screened; guests canned-only) ·
                 source (separate, audited — never implicit with a ticket)
/api/billing/* → Razorpay order + verified/idempotent webhook
/api/session   → SSO whoami (verifies shared ariantra_session cookie)
/api/logout    → clears the .ariantra.com session cookie (signs out ALL surfaces)
/api/arcade/publish → parent-PIN + session gate → platform partner bridge
                 (server-to-server publish/list/slug-check; the platform
                 re-verifies everything — see platform ARCHITECTURE.md §Partner;
                 publishes forward the chat id → Game.sourceChatId, the link
                 behind Studio's "Edit in Games-Lab" deep link)
/api/arcade/edit-source → session gate (no PIN — read-only) → partner getCode:
                 the owner's clean single-file game code, seeding an edit chat
                 (lib/edit-entry.ts; arrival = /?edit=<slug>&chat=<id?>)
   │
   ▼ src/lib/db.ts — Store interfaces (AlertStore, UsageStore, RateLimitStore, PaymentStore)
SQLite (better-sqlite3, WAL): alerts · usage_events · ip_limits · payments · webhook_events
                              · conversations · turn_results · parent_auth · screen_time_*
                              · help_tickets · help_replies · help_audit
```

- Stores are behind interfaces (dependency inversion) — swapping SQLite for
  Mongo later is an adapter change, not an app rewrite.
- SQLite ⇒ **single instance only**. Prod path `/var/lib/kidgemini/kidgemini.db`
  (absolute `DATABASE_PATH`), daily WAL-safe `.backup` cron.

## Auth (Ariantra SSO — no local OAuth)

Login happens ONCE on the platform (`studio.ariantra.com/login` — Google or
username/password). The platform sets the `ariantra_session` cookie
(Domain=.ariantra.com, HS256 JWT); this app verifies it with the SHARED
`AUTH_JWT_SECRET` (`src/lib/ariantra-session.ts`, pure + tested) and keys rows
by `user:<email>` (continuity with pre-SSO accounts). Client state:
`src/lib/useAriantraSession.tsx` (drop-in useSession/signIn/signOut). Fail
closed everywhere: no/invalid cookie ⇒ /api/chat 401.

## Hosting (prod)

Co-hosted on the Ariantra EC2 box as a second Next app:

```
games-lab.ariantra.com ── Caddy (explicit block, LE cert) ──► 127.0.0.1:3001 (pm2 "kidgemini") — CANONICAL
ari.ariantra.com        ── Caddy (legacy alias, still live during transition) ──► same
kidgemini.ariantra.com  ── Caddy (legacy alias, still live during transition) ──► same
ariantra platform       ── api/studio/games.ariantra.com   ──► 127.0.0.1:3000
```

Deploy: `npm run deploy` = sync brand CSS → build locally → rsync artifacts →
`npm ci --omit=dev` on lockfile change (better-sqlite3 compiles on the box) →
pm2 restart. Runbook: `../Ariantra-Platform/docs/DEPLOY_RUNBOOK.md` §7.

## Shared Ariantra brand

`ArNav` (in the root layout) + `public/brand/ariantra-brand.v1.css` — a local
copy of the platform-generated brand kit (`npm run sync:brand` refreshes it;
deploy runs it automatically). Body is a 100dvh flex column: sticky header on
top, `.ar-app-main` owns scrolling; screens size with `h-full`, not `h-screen`.
