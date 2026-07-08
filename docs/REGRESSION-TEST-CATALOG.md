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

## Game preview console (2026-07-08)

| When to run | Test | What it pins | Bug-fix ref |
|---|---|---|---|
| `src/lib/game-console.ts`, `src/components/ArtifactFrame.tsx` | **`src/lib/game-console.test.ts`** (7 tests, passing; runs the injected script for real in `node:vm`, not just string matching) | Capture script is injected as early as possible (`<head>` → after `<html>` → doc start) and never double-injected; `console.log/warn/error`, `window.onerror`, and `unhandledrejection` all forward a `GameConsoleMessage` to the parent via `postMessage` | — (new feature, not a bug fix) |
| `src/lib/three-vendor.ts`, `scripts/vendor-three.mjs`, `src/lib/gemini.ts` (CHILD_SYSTEM_PROMPT's Three.js import list) | **`src/lib/three-vendor.test.ts`** (6 tests, passing) | Plain 2D games pass through byte-identical (no `USES_THREE` marker ⇒ no-op); marked games get the marker stripped + a `<script type="importmap">` inserted as early as possible, mapping the bare specifier `"three"` to a base64 `data:` URI; that bundle is verified tree-shaken (no leftover relative imports that would break from a data: URI) and actually contains the classes the prompt teaches (`PerspectiveCamera`, `WebGLRenderer`, `BoxGeometry`, `MeshStandardMaterial`, `Scene`) | — (new feature, not a bug fix) |

## 3D game delivery (2026-07-08)

| When to run | Test | What it pins | Bug-fix ref |
|---|---|---|---|
| `scripts/deploy-rsync.sh`, `src/lib/three-vendor.ts` | **`src/lib/three-vendor.deploy.test.ts`** (2 tests, passing) | The deploy ship list includes `src/lib/vendor` (read at runtime via `readFileSync` — NOT bundled into `.next`), and the vendored bundle exists locally | BUG-FIX-LOG 2026-07-08 (3D preview dead in prod) |
| `src/app/api/chat/route.ts` (artifact post-processing) | **`src/app/api/chat/route.test.ts`** P.1/P.2 | The `done` event can never be lost to post-processing: injector throws ⇒ raw artifact still delivered (preview opens); injector succeeds ⇒ injected html delivered | BUG-FIX-LOG 2026-07-08 (same) |

## Chat history trim (2026-07-08)

| When to run | Test | What it pins | Bug-fix ref |
|---|---|---|---|
| `src/lib/history-trim.ts`, `src/app/api/chat/route.ts` | **`src/lib/history-trim.test.ts`** (7 tests, passing) | Only the newest game's code reaches the model (older versions → placeholder, prose kept); child messages never touched; 12-message sliding window; the newest game is swapped INTO the window when it falls outside (cap still holds); empty history safe | — (token-cost optimization, not a bug fix) |

## Published-game sizing (2026-07-08)

| When to run | Test | What it pins | Bug-fix ref |
|---|---|---|---|
| `src/lib/gemini.ts` (CHILD_SYSTEM_PROMPT's sizing instructions) | **`src/lib/gemini.test.ts`** (1 test, passing) | The prompt requires `height:100dvh`, never a bare `height:100vh` sizing instruction — `100vh` doesn't shrink for a mobile browser's address bar, hiding a game's own bottom on-screen controls | BUG-FIX-LOG 2026-07-08 (backward-compatible half in `Ariantra-Platform` `docs/BUG_LOG.md` #9) |
