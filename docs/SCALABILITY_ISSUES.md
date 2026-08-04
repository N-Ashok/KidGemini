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

## 4. LLM calls per turn — **RESOLVED as a cost issue 2026-07-09 (safety posture change)**

> **2026-07-09 (owner decision):** the Flash-Lite classifier was removed from `/api/chat`
> (it retracted harmless games — see BUG-FIX-LOG 2026-07-09). Per-turn cost is now **1 chat
> call** (deterministic input rules are free). The former 2–3× safety-call multiplier is gone;
> the trade is safety-coverage, not scale — output safety now rests on Gemini built-in
> thresholds + the child-safety system prompt. If the classifier is ever re-enabled
> (trigger: unsafe output reaching a child), the cost levers below apply again.

### Original analysis — **(was) ACCEPTED (safety, non-negotiable)**

- **Compromise (cost for safety):** every turn runs a chat generation **plus** a Flash-Lite output
  monitor, **plus** a background input classifier (`src/app/api/chat/route.ts`). Cost scales ~2–3×
  the chat-only token volume.
- **Ready plan (cost levers that preserve fail-closed):** deterministic input rules
  short-circuit safe prompts before any input-LLM block; (a) cache classifier verdicts
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

## 6. Payments stored in file-local SQLite (`payments`, `webhook_events`) — **ACCEPTED (inherits #1)**

- **Decided:** 2026-06-26. Razorpay one-time payment rails ship recording state in SQLite
  (`payments`, `webhook_events` in `src/lib/db.ts`), the same file-local store as #1.
- **What:** `payments` (one row per order) and the `webhook_events` idempotency table are
  per-instance/file-local. On a multi-instance or serverless deploy: (a) the webhook may land on a
  different instance than the one that created the order — it still works (it looks up by
  `razorpayOrderId`), but only if all instances share the DB file, which file-local SQLite does
  **not** guarantee; (b) the `webhook_events` idempotency guard is per-file, so the same event
  retried against two instances could be processed twice; (c) `webhook_events` is append-only with
  no rotation.
- **Why accepted:** "rails only, no entitlement gate yet" + single-box pilot. Money volume is low
  and the webhook is idempotent **within** an instance; the source-of-truth is recoverable from
  Razorpay's dashboard/API if state diverges.
- **Limit:** correctness of payment state depends on **one shared DB**. Diverges exactly when #1
  diverges (multi-instance / serverless). `webhook_events` grows unbounded.
- **Trigger to act:** any multi-instance / serverless deploy (same trigger as #1) · before wiring a
  real **entitlement gate** on payment state (divergence becomes user-visible: paid users wrongly
  blocked / unpaid wrongly allowed) · payment volume growth.
- **Ready plan:** move `payments` + `webhook_events` to the shared hosted DB in #1's migration
  (Postgres/Turso); make idempotency a single `INSERT … ON CONFLICT` against that shared table.
  Add rotation/archival for `webhook_events`. Until then, treat Razorpay's dashboard as the
  reconciliation source of truth. **Effort:** folds into the #1 migration; ~2–3 hours for the
  idempotency/rotation specifics.

## 7. Preview Perf Panel's per-model instance array is unbounded per game session — **ACCEPTED (capped, with plan)**

- **Decided:** 2026-07-30, `docs/2026-07-30_PRD_PreviewPerfPanel.md` — built to diagnose a real
  incident: a generated cricket game loaded 24 separately-animated 3D characters (3 principals +
  9 fielders + 12 crowd) and heated up the owner's laptop, with no way to see which part was
  responsible short of reading the generated source by hand. **This is the named precedent for
  the "crowd/character-count" load class** — any future heavy game (multiplayer crowds, particle
  effects, big worlds) hits the same shape of problem, and the perf panel is the general answer,
  not a one-off fix for cricket.
- **What:** `loadModel()` (`src/lib/assets/runtime-helpers.ts`) pushes every successfully-loaded
  root `Object3D` into `window.__arPerf.models[name].instances`, a plain in-memory array, so the
  debug perf-probe can report live instance counts without the generated game's code ever knowing
  it's being watched. A pathological game that spawns and despawns the same named model in a tight
  loop (a bullet-hell shooter, a particle-like crowd system) would otherwise grow that array
  forever for the life of the tab — a real memory leak, holding strong references that block GC
  even after the mesh is removed from the scene.
- **Why accepted (capped, not fixed):** this is debug/dev telemetry — it runs on every preview
  render (so it reaches games that already exist, same as the frame governor), but nothing reads
  it unless `kidgemini:debug === "1"` is set, and a preview tab is a short-lived session, not a
  long-running server process. `MAX_TRACKED_INSTANCES = 1_000` (`runtime-helpers.ts`) bounds the
  array by dropping the oldest entry once it's exceeded — a cheap, adequate cap for the sessions
  this panel is actually used in.
- **Limit:** a single game session that calls `loadModel("samename")` far more than ~1,000 times
  still holds up to 1,000 stale strong references per model name until the tab closes; the perf
  probe itself already ignores unparented ("dead") instances when it *counts* live ones (never a
  stale row in the UI), but the array entries themselves aren't pruned until the cap forces a drop.
- **Trigger to act:** a real game generation pattern that spawns/despawns one named model far more
  than 1,000 times per session (not observed yet) · this panel graduating from debug-only to an
  always-on telemetry path.
  **Partial update (2026-08-04):** a SUMMARY now does — `lib/perf-report.ts`'s `buildSlowGameReport`
  logs `{docKey, fps, heaviestModel: {name, instances, animated}}` server-side (`[perf]` tag,
  `POST /api/perf/slow-game`) whenever `slowdown-nudge.ts`'s kid-facing banner fires, i.e. for EVERY
  real kid session (not just `kidgemini:debug` ones) that hits a sustained slowdown — `usePerfProbe`
  itself already ran unconditionally regardless of the debug flag (only the Perf TAB's UI was
  gated), this just adds a reporting consumer. Still bounded/low-risk: the sample it reads is a
  single already-computed snapshot (not the raw `window.__arPerf` instance array this section is
  about), and it's naturally throttled by the SAME 45s cooldown + 5-consecutive-sample debounce
  that already gates the banner — so this doesn't change the underlying cap/limit analysis above,
  only who can now see a slowdown happened.
- **Ready plan:** switch `instances` to hold `WeakRef<Object3D>` (or prune entries whose `.parent`
  is falsy on each perf-probe sample, not just at read time) so dead instances stop pinning memory
  the moment they're removed from the scene, rather than waiting for the 1,000-entry cap.
  **Effort:** ~1 hour — the perf-probe sample loop already walks every instance to check `.parent`;
  pruning there instead of just skipping is a small, contained change.

## 8. `game_saves` rows for a deleted conversation — **RESOLVED for the cascade; GC sweep for pre-existing orphans still open**

- **2026-08-03, Phase 1:** flagged as accepted-with-plan while the feature was backend-only and
  unwired (no game could emit `<!--SUPPORTS_SAVE-->` yet, so no row could exist in production).
- **2026-08-03, Phase 2 (same day, feature went live):** the cascade landed as promised —
  `SqliteChatHistoryStore.softDelete` (`src/lib/db.ts`) now runs inside `getDb().transaction(...)`
  and calls `GameSaveStore.deleteByConversation(id)` (DI'd via the constructor, defaulting to
  `SqliteGameSaveStore`) whenever the soft-delete actually matches a row — atomic, so a crash
  between the two statements can never leave an orphaned save. Covered by
  `db.chat-history.test.ts` H.16–H.18 (cascade fires, fail-closed no-op doesn't cascade, DI is
  exercised with a fake store) and `db.game-saves.test.ts` (`deleteByConversation` itself).
- **Still open — pre-existing orphans:** the cascade only covers deletes going forward. Rows
  created before this fix (there should be none, since the feature was unwired until the same
  change that added the cascade — but a DB restored from a backup taken mid-window could in
  principle carry one) and any future orphan from an out-of-band path (a raw SQL delete, a manual
  admin fix) still need a sweep. `stateJson` stays capped at 1.5MB per row (`MAX_STATE_JSON_BYTES`,
  `src/lib/game-save.config.ts`) regardless — a single-area game needs a few KB, but a multi-area
  "build your universe" world accumulates one entry per object across every area a kid has ever
  built, so undercapping would mean a kid's second or third city silently stops saving while the
  first keeps working, which is worse than one clear limit.
- **Trigger to act on the GC sweep:** a `game_saves` row is ever observed with no matching
  `conversations` row (should be structurally impossible now, but worth a periodic check) — or the
  table's row count meaningfully exceeds `conversations`' row count.
- **Ready plan:** a nightly GC sweep for `game_saves` rows whose parent conversation no longer
  exists (same idiom as `SqliteHelpStore.pruneClosedText`'s sweep-on-write) — additive, no
  migration risk. **Effort:** ~30 min; low priority since the cascade already prevents new orphans.
