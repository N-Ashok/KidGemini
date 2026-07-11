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
| `src/app/api/chat/route.ts` | **`src/app/api/chat/route.test.ts`** R.1 | Input rules block before streaming; a streamed game reaches `done` and is **never** followed by a `retract` (post-hoc retraction class — chess block). | 2026-07-09 (monitor removed) |
| `src/lib/gemini.ts` (`CHILD_SYSTEM_PROMPT`, `GEN_CONFIG`) | **`src/lib/gemini.prompt.test.ts`** (3 tests, passing) | The child-safety system instruction (age 7–14, be-careful/be-cautious, never-refuse-a-game) exists — it REPLACED the Flash-Lite output monitor and must not silently disappear. | 2026-07-09 (monitor removed) |
| `src/lib/mic-errors.ts`, `src/components/useSpeechInput.ts` | **`src/lib/mic-errors.test.ts`** (5 tests, passing) | Kid-friendly message per error code; fatal/non-fatal split — pauses ("no-speech"/"aborted") keep the mic alive, only permission/hardware/network end the session. | 2026-07-07, 2026-07-09 (mic keep-alive) |
| `src/lib/stream-recovery.ts`, `src/components/ChatPanel.container.tsx` (`runStream`), `src/components/useWakeLock.ts` | **`src/lib/stream-recovery.test.ts`** (5 tests, passing) | Dropped/stalled streams auto-retry up to the limit; manual Stop and finalized replies never retry; retry limit stays ≤ 2 (each retry is a paid generation). | 2026-07-09 (wake lock + auto-retry) |
| `src/app/api/chat/route.ts`, `src/auth.ts`, `src/components/ChatPanel.container.tsx`, `src/components/SignInScreen.tsx` | **`src/app/api/chat/route.test.ts`** (2 tests, passing) | Force-login: unauthenticated POST ⇒ HTTP 401 `auth_required` and Gemini is **never** called (fail-closed, no anonymous cost); authenticated POST streams. | 2026-06-25 (force-login) |
| `src/app/api/chat/route.ts`, `src/lib/gate.config.ts`, `src/lib/db.ts` (`tokensUsedByUser`) | _(to be written)_ gate integration test | Guest blocked at ≥ `GUEST_TOKEN_LIMIT` (chat+safety tokens); signed-in unlimited; guest cookie issued; `auth()` failure fails safe to guest. | — |
| `src/lib/rate-limit.ts`, `src/lib/rate-limit.config.ts` | **`src/lib/rate-limit.test.ts`** (10 tests, passing) | Per-IP policy: allow ≤ limit; block (max+1) until next UTC day; window reset; strikes persist across days; `mustPay` at the strike cap; recovery next day. | SCALABILITY_ISSUES #3 |
| `src/lib/db.ts` (`SqliteRateLimitStore`, `ip_limits`), `src/app/api/chat/route.ts` (rate-limit wiring) | _(to be written)_ store + route integration test | Persistence round-trips the record; guests rate-limited, signed-in exempt; `rate_limited`/`paywall` events emitted. | SCALABILITY_ISSUES #3 |

> Rows marked _(to be written)_ are the retrofit owed per `docs/KNOWN_BUGS.md` #1. Replace the
> placeholder path with the real test file and add the bug-fix ref when each lands.

---

## Payment (Razorpay) contracts

| When to run (file touched) | Test to run | What it pins | Bug-fix ref |
|---|---|---|---|
| `src/lib/razorpay.ts` | **`src/lib/razorpay.test.ts`** (8 tests, passing) | Signature verification is the payment security boundary: valid ⇒ accept; tampered/empty ⇒ reject; **fail-closed** when no secret; `createOrder` POSTs with basic auth and propagates non-OK as an error. | KNOWN_BUGS #2 |
| `src/app/api/billing/order/route.ts`, `src/lib/auth-identity.ts`, `src/lib/billing.config.ts` | **`src/app/api/billing/order/route.test.ts`** (3 tests, passing) | Unauthenticated ⇒ 401 and Razorpay never called; unknown plan ⇒ 400; authed ⇒ order created + recorded. | KNOWN_BUGS #2 |
| `src/app/api/billing/webhook/route.ts`, `src/lib/db.ts` (`SqlitePaymentStore`) | **`src/app/api/billing/webhook/route.test.ts`** (3 tests, passing) | Invalid signature ⇒ 400 + no write (fail-closed); valid `payment.captured` ⇒ `markPaid`; duplicate event id ⇒ idempotent (not paid twice). | KNOWN_BUGS #2, SCALABILITY_ISSUES #6 |

## Gate funnel (guest trial + paid budget)

| When to run | Test | What it pins | Bug-fix ref |
|---|---|---|---|
| `src/app/api/chat/route.ts`, `src/lib/gate.config.ts`, `src/lib/db.ts` (usage store) | `src/app/api/chat/route.test.ts` | Guest 10K trial streams then 401-walls; IP cap defeats cookie-clearing; 429/402 statuses; signed-in budget OFF by default; Gemini never called on any blocked path; all blocks are HTTP statuses (silent-hang class) | BUG-FIX-LOG 2026-06-25 + follow-up 2026-07-03 |

## Chat history trim (2026-07-08, re-introduced after the same-day revert)

| When to run | Test | What it pins | Bug-fix ref |
|---|---|---|---|
| `src/lib/history-trim.ts`, `src/app/api/chat/route.ts` | **`src/lib/history-trim.test.ts`** (7 tests, passing) | Only the newest game's code reaches the model (older versions → placeholder, prose kept); child messages never touched; 12-message sliding window; the newest game is swapped INTO the window when it falls outside (cap still holds); empty history safe | — (token-cost optimization, not a bug fix) |

## Game preview console (2026-07-08, re-introduced after the same-day revert)

| When to run | Test | What it pins | Bug-fix ref |
|---|---|---|---|
| `src/lib/game-console.ts`, `src/components/ArtifactFrame.tsx` | **`src/lib/game-console.test.ts`** (7 tests, passing; runs the injected script for real in `node:vm`, not just string matching) | Capture script is injected as early as possible (`<head>` → after `<html>` → doc start) and never double-injected; `console.log/warn/error`, `window.onerror`, and `unhandledrejection` all forward a `GameConsoleMessage` to the parent via `postMessage` | — (new feature, not a bug fix) |

## Starter suggestion chips (2026-07-08)

| When to run | Test | What it pins | Bug-fix ref |
|---|---|---|---|
| `src/lib/game-suggestions.ts`, `src/components/ChatPanel.container.tsx` (chips) | **`src/lib/game-suggestions.test.ts`** (7 tests, passing) | Pool holds ≥500 unique non-empty game prompts; every entry starts a game ("Make me a … game"); `pickSuggestions` returns 4 distinct pool entries, is rand-injectable/deterministic, safe when count > pool | — (feature, not a bug fix) |

## Preview pane: full-screen + old-game-during-update (2026-07-11)

| When to run | Test | What it pins | Bug-fix ref |
|---|---|---|---|
| `src/lib/preview-pane.ts`, `src/components/ArtifactFrame.tsx`, `src/components/ChatPanel.container.tsx` (artifact swap), `src/components/usePreviewVerify.ts` | **`src/lib/preview-pane.test.ts`** (15 tests, passing) | Panel shell classes for split/full-screen incl. the z-[110]-above-nav pin; Esc collapses only when expanded; `nextArtifact` policy (done-with-html swaps, done-without/regenerate/send keep the OLD game, safety retract blanks); `previewDocKey` never collides across game generations | BUG-FIX-LOG 2026-07-11 ×2 (round collision; verify restart on new ask) |
| Same files — anything touching the update/verify flow end-to-end | **`scripts/e2e-preview-pane.mjs`** (real browser; needs `npm run dev` + playwright-core, see script header) | Expand/collapse without iframe remount and back to the same width; old game visible + uncovered + updating strip while a change streams; the NEW game actually reaches the iframe after `done` (round-collision class) | BUG-FIX-LOG 2026-07-11 |
