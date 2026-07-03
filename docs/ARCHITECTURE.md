# KidGemini Architecture

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
/api/chat      → safety gate (Gemini safety model) → chat (Gemini chat model)
/api/safety    → standalone safety checks
/api/alerts    → parent alert feed (PIN-gated)
/api/usage     → usage/cost admin feed
/api/billing/* → Razorpay order + verified/idempotent webhook
/api/auth/*    → Auth.js v5 (Google), trustHost
   │
   ▼ src/lib/db.ts — Store interfaces (AlertStore, UsageStore, RateLimitStore, PaymentStore)
SQLite (better-sqlite3, WAL): alerts · usage_events · ip_limits · payments · webhook_events
```

- Stores are behind interfaces (dependency inversion) — swapping SQLite for
  Mongo later is an adapter change, not an app rewrite.
- SQLite ⇒ **single instance only**. Prod path `/var/lib/kidgemini/kidgemini.db`
  (absolute `DATABASE_PATH`), daily WAL-safe `.backup` cron.

## Hosting (prod)

Co-hosted on the Ariantra EC2 box as a second Next app:

```
kidgemini.ariantra.com ── Caddy (explicit block, LE cert) ──► 127.0.0.1:3001 (pm2 "kidgemini")
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
