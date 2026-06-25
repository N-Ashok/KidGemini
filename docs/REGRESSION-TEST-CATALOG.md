# Regression Test Catalog

> **Purpose:** Map test files to the production code they protect. When you touch a file in the
> left column, run the tests in the right column **before** committing. These are the *minimum* —
> the full suite still catches more. Maintained alongside `docs/BUG-FIX-LOG.md`: every bug-fix
> that adds a test adds a row here.

Commands:

```bash
npm run test                 # Vitest — full unit + integration suite (with coverage)
npm run test -- <pattern>    # Vitest — single file / pattern
npm run test:e2e             # Playwright — browser e2e / regression
npm run typecheck            # tsc --noEmit
```

---

## How to read this catalog

- **"When to run"** = trigger file paths. Touching any matching file ⇒ run that test before commit.
- **"What it pins"** = the contract / regression class the test locks in.
- **"Bug-fix ref"** = the `BUG-FIX-LOG.md` entry that created or last fortified the test.

---

## Safety & gate contracts

| When to run (file touched) | Test to run | What it pins | Bug-fix ref |
|---|---|---|---|
| `src/lib/safety.ts`, `src/lib/safety.rules.ts`, `src/lib/safety.config.ts` | _(to be written)_ `src/lib/safety.test.ts` | Fail-closed: classifier error/uncertain ⇒ block + log, never show. | — |
| `src/app/api/chat/route.ts` | _(to be written)_ `src/app/api/chat/route.test.ts` | Input rules block before streaming; output monitor can retract; unvetted content never reaches the client. | — |
| `src/app/api/chat/route.ts`, `src/auth.ts`, `src/components/ChatPanel.container.tsx`, `src/components/SignInScreen.tsx` | **`src/app/api/chat/route.test.ts`** (2 tests, passing) | Force-login: unauthenticated POST ⇒ HTTP 401 `auth_required` and Gemini is **never** called (fail-closed, no anonymous cost); authenticated POST streams. | 2026-06-25 (force-login) |
| `src/app/api/chat/route.ts`, `src/lib/gate.config.ts`, `src/lib/db.ts` (`tokensUsedByUser`) | _(to be written)_ gate integration test | Guest blocked at ≥ `GUEST_TOKEN_LIMIT` (chat+safety tokens); signed-in unlimited; guest cookie issued; `auth()` failure fails safe to guest. | — |
| `src/lib/rate-limit.ts`, `src/lib/rate-limit.config.ts` | **`src/lib/rate-limit.test.ts`** (10 tests, passing) | Per-IP policy: allow ≤ limit; block (max+1) until next UTC day; window reset; strikes persist across days; `mustPay` at the strike cap; recovery next day. | SCALABILITY_ISSUES #3 |
| `src/lib/db.ts` (`SqliteRateLimitStore`, `ip_limits`), `src/app/api/chat/route.ts` (rate-limit wiring) | _(to be written)_ store + route integration test | Persistence round-trips the record; guests rate-limited, signed-in exempt; `rate_limited`/`paywall` events emitted. | SCALABILITY_ISSUES #3 |

> Rows marked _(to be written)_ are the retrofit owed per `docs/KNOWN_BUGS.md` #1. Replace the
> placeholder path with the real test file and add the bug-fix ref when each lands.
