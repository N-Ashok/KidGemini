# Ari (formerly KidGemini) Architecture

One-page system map. Build rules: `../CLAUDE.md`; product: `PRD.md`;
scaling constraints: `SCALABILITY_ISSUES.md`.

## Shape

Next.js 14 (App Router, TypeScript strict) — frontend + secure backend in one
repo. All AI + safety + billing logic is server-side; the browser never sees
secrets or the raw Gemini API.

```
Browser ── pages: / (chat) · /parent · /admin · /upgrade
   │
   ▼ API routes (runtime: nodejs)
/api/chat      → history trim (newest game + last 12 msgs, lib/history-trim.ts)
                 → input rules (deterministic, lib/safety.rules.ts)
                 → chat (Gemini chat model: built-in safety thresholds +
                   child-safety system prompt; no output monitor — 2026-07-09)
/api/safety    → standalone safety checks (Flash-Lite classifier)
/api/alerts    → parent alert feed (PIN-gated)
/api/usage     → usage/cost admin feed
/api/billing/* → Razorpay order + verified/idempotent webhook
/api/session   → SSO whoami (verifies shared ariantra_session cookie)
/api/logout    → clears the .ariantra.com session cookie (signs out ALL surfaces)
/api/arcade/publish → parent-PIN + session gate → platform partner bridge
                 (server-to-server publish/list/slug-check; the platform
                 re-verifies everything — see platform ARCHITECTURE.md §Partner)
   │
   ▼ src/lib/db.ts — Store interfaces (AlertStore, UsageStore, RateLimitStore, PaymentStore)
SQLite (better-sqlite3, WAL): alerts · usage_events · ip_limits · payments · webhook_events
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
ari.ariantra.com       ── Caddy (explicit block, LE cert) ──► 127.0.0.1:3001 (pm2 "kidgemini")
kidgemini.ariantra.com ── Caddy (legacy alias, still live during rename transition) ──► same
ariantra platform      ── api/studio/games.ariantra.com   ──► 127.0.0.1:3000
```

Deploy: `npm run deploy` = sync brand CSS → build locally → rsync artifacts →
`npm ci --omit=dev` on lockfile change (better-sqlite3 compiles on the box) →
pm2 restart. Runbook: `../Ariantra-Platform/docs/DEPLOY_RUNBOOK.md` §7.

## Shared Ariantra brand

`ArNav` (in the root layout) + `public/brand/ariantra-brand.v1.css` — a local
copy of the platform-generated brand kit (`npm run sync:brand` refreshes it;
deploy runs it automatically). Body is a 100dvh flex column: sticky header on
top, `.ar-app-main` owns scrolling; screens size with `h-full`, not `h-screen`.
