# Known Bugs & In-Progress

> **Past fixes:** see `docs/BUG-FIX-LOG.md`. Add an entry there whenever a fix lands.
> Statuses: `TODO` · `IN PROGRESS` · `WATCHING` · `DONE (needs UAT)` · `FIXED`.

| # | Issue | Status | Details |
|---|-------|--------|---------|
| 2 | Real payments not implemented — pay wall is a prompt only | TODO 2026-06-24 | The per-IP rate limiter (`docs/SCALABILITY_ISSUES.md` #3) shows an "Upgrade — coming soon" prompt after 3 strikes (`src/components/LoginGate.tsx`, `showUpgrade`), but there is no billing. **Owed (own PRD):** choose a provider (e.g. Stripe), pricing/plans, checkout, webhooks, and an `entitlement` on the user that exempts paid accounts from the gate + rate limit. Until then, a struck-out guest can only wait until next day or sign in with Google. |
| 1 | Auth + guest-gate feature shipped without tests | PARTIAL 2026-06-24 | The Google sign-in (`src/auth.ts`, `/api/auth/[...nextauth]`), the server-enforced 10k-token guest gate (`src/app/api/chat/route.ts`, `src/lib/gate.config.ts`, `tokensUsedByUser()` in `src/lib/db.ts`), and the responsive mobile sidebar/artifact panel were built feature-first, in violation of the now-mandatory test-first rule (`CLAUDE.md` §7.4). **Vitest is now stood up** (the rate-limit work, 2026-06-24, added it) — so the runner blocker is gone. **Retrofit still owed:** unit-test `tokensUsedByUser()` + `gate.config`; integration-test `/api/chat` (gate fires at limit, signed-in unlimited, cookie issuance, fail-closed when `auth()` throws); add Playwright + e2e the mobile drawer + gate modal. Then update `docs/PRD.md` and produce the UAT package. |
