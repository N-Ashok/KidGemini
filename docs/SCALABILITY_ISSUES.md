# Scalability Issues & Accepted Trade-offs

Register of known scale limits. Per `CLAUDE.md` §10, any change that introduces an unbounded
query, per-instance/file-local state, or an un-rotated append-only table must be **stopped,
documented here, and signed off in the plan** before it ships — either fixed or accepted with a
clear "revisit when" trigger.

Statuses: `ACCEPTED` (known limit, deliberately deferred) · `OPEN` (needs action) · `RESOLVED`.

---

## 1. SQLite is single-host (file-based persistence) — **ACCEPTED**

- **Decided:** 2026-06-24 by the human. *"SQLite is OK; we'll move it when it becomes a bottleneck."*
- **What:** Persistence is `better-sqlite3` against a local file (`DATABASE_PATH`, default
  `./data/kidgemini.db`; `src/lib/db.ts`). It does not scale horizontally — multiple app
  instances / serverless functions each get their own filesystem, so usage tallies and the guest
  token gate diverge across instances, and ephemeral storage loses data on redeploy. Queries are
  also synchronous and block the Node event loop under load.
- **Why accepted:** Fine for a single-box pilot. The real ceiling at this scale is Gemini rate
  limits/cost, not the DB. The `UsageStore` / `AlertStore` interfaces (Dependency Inversion,
  CLAUDE.md §4) mean the swap is contained to `db.ts`, not the call sites.
- **Revisit when ANY of:** deploying to serverless or >1 app instance · the app moves off a
  persistent-disk host · write latency/lock contention shows up in logs · `usage_events` row
  count makes the gate query slow (see #2).
- **Migration path (when triggered):** the full trigger list + step-by-step runbook is on the
  shelf in **`docs/SCALABILITY_MIGRATION_PLAN.md`** — Turso/libSQL (keeps the SQLite SQL, lowest
  effort) or Postgres, selected by a config switch, contained by the `UsageStore` interface.

## 2. Guest-gate query is unbounded and unindexed — **PARTIAL (index landed 2026-06-24)**

> Index `idx_usage_userId (userId, createdAt)` added to `usage_events` (`src/lib/db.ts`) — the
> per-request `SUM` is now an index lookup, not a full scan. Still open: running counter +
> `usage_events` rotation (deferred, lower urgency now the scan is gone).


- **What:** `tokensUsedByUser()` (`src/lib/db.ts`) runs
  `SELECT SUM(promptTokens + outputTokens) WHERE userId = ?` on **every** chat request. The only
  index is on `createdAt` (`idx_usage_createdAt`), so this scans all of a user's rows, and
  `usage_events` is append-only and grows forever → per-message cost rises over time.
- **Fix (deferred, low-risk, stays on SQLite):** add an index on `(userId, createdAt)`; keep a
  running per-user token counter (one row) instead of summing history each request; rotate/cap
  `usage_events`. Tracked in `docs/KNOWN_BUGS.md`.
- **Revisit when:** doing the auth/gate test retrofit, or sooner if usage volume climbs.

## 3. No inbound rate-limit on `/api/chat` (LLM-cost path) — **RESOLVED for single-instance (2026-06-24)**

> Per-IP rate limit shipped: 30 req / 5 min, guests only (signed-in exempt), hard-block until next
> UTC day, 3 strikes → pay wall prompt. Pure logic `src/lib/rate-limit.ts` (10 unit tests), state in
> `ip_limits` (`SqliteRateLimitStore`), wired into `/api/chat`. **Still open:** (a) the limiter state
> is in SQLite, so it inherits #1's single-host limit — when multi-instance, move the counter to the
> shared store; (b) **real payments** are deferred (the pay wall is a prompt only) — see KNOWN_BUGS #2.
> Original analysis kept below for context.

### Original analysis — **(was) ACCEPTED (with plan)**

- **Decided:** 2026-06-24 — shipped without inbound throttling to move fast.
- **Compromise (cost for speed-to-launch):** `/api/chat` has no per-IP / per-identity rate limit
  (`src/lib/retry.ts` only retries *upstream* Gemini 429s). Each turn costs 1 chat call + up to 2
  Flash-Lite safety calls. The 10k guest gate caps a single guest, but a client can mint fresh
  `kg_guest` cookies to reset it → a determined abuser can drive unbounded Gemini spend.
- **Limit:** cost is bounded only by Gemini's own quota, not by us. One abusive IP can dominate spend.
- **Trigger to act:** cost spike or one IP/geo dominating the `/admin` usage dashboard ·
  Gemini 429s in `logs/app.log` · any public-traffic growth · before any unauthenticated launch push.
- **Ready plan:** add a token-bucket rate limit at the `/api/chat` edge — per IP **and** per
  resolved identity (guest cookie / user) — before the LLM calls. Single instance: in-memory bucket.
  Multi-instance: a shared counter store (same hosted-DB target as #1, or Redis). Tighten the guest
  path: rate-limit by IP (not just cookie) so new-cookie evasion is throttled. **Effort:** ~half a
  day single-instance; folds into the #1 migration for the shared-store version.

## 4. 2–3 LLM calls per turn (input + output safety + chat) — **ACCEPTED (safety, non-negotiable)**

- **Compromise (cost for safety):** every turn runs a chat generation **plus** a Flash-Lite output
  monitor, **plus** a background input classifier (`src/app/api/chat/route.ts`). Cost scales ~2–3×
  the chat-only token volume. This is intentional and **stays** — fail-closed safety is the product
  (CLAUDE.md §3); we don't trade it away for cost.
- **Limit:** per-turn LLM cost ≈ chat + 2× safety classifier; the safety model can dominate spend at volume.
- **Trigger to revisit (optimize, never weaken):** safety-model spend dominating the cost dashboard.
- **Ready plan (cost levers that preserve fail-closed):** deterministic input rules already
  short-circuit safe prompts before any input-LLM block (keep that); (a) cache classifier verdicts
  for identical/near-identical content; (b) keep the cheapest model that still passes the safety
  bar; (c) batch/sample output monitoring **only** for provably low-risk classes, with the default
  staying "classify + fail closed." Any change here needs new safety tests (CLAUDE.md §7.4).

## 5. File logger `logs/app.log` — unbounded, per-instance, sync — **ACCEPTED (with plan)**

- **Compromise (simplicity/speed for ops):** `src/lib/logger.ts` tees console to a local append-only
  file. It never rotates (grows forever), is **per-process/per-instance** (fragmented across
  instances, lost on ephemeral disk), and writes synchronously in the request hot path.
- **Limit:** disk fills over time; logs aren't centralized; sync writes add hot-path latency at high QPS.
- **Trigger to act:** disk-pressure warnings · multi-instance / serverless deploy (same architectural
  trigger as #1) · needing centralized/searchable logs for incident response.
- **Ready plan:** add size/time **log rotation** (or cap + truncate) for single-instance; when going
  multi-instance, drop the file tee and log to **stdout** for the platform's log aggregator
  (Vercel/Cloud Run/Datadog). **Effort:** ~2–3 hours rotation; ~half a day for stdout + aggregator wiring.
