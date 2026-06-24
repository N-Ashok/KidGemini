# DB Migration Plan — SQLite → hosted DB

**Status:** on the shelf (not yet triggered). Companion to `docs/SCALABILITY_ISSUES.md` #1.

We deliberately run on file-based SQLite today (single-host pilot). This doc is the pre-agreed
answer to two questions so we never have to improvise under pressure:

1. **What symptom tells us it's time to migrate?**
2. **What is the exact plan to migrate?**

---

## 1. Triggers — migrate when ANY of these fire

Two kinds: **architectural** (a decision forces it — migrate *before* shipping) and **symptomatic**
(the running system tells us — migrate *now*). Watch via `logs/app.log` (the logger tees console
there) and the `/admin` usage dashboard.

### Architectural triggers (decide → migrate first, don't wait for pain)
- **Going serverless** (Vercel functions, Cloud Run with >1 instance, any autoscaling). File-local
  state can't be shared → the guest gate and usage tally silently diverge per instance. **Hard blocker.**
- **Horizontal scale** — running 2+ app instances behind a load balancer, for any reason.
- **Host without a persistent disk** — ephemeral container storage loses `data/kidgemini.db` on
  every redeploy.

### Symptomatic triggers (observe → migrate now)
| Symptom | Where it shows | Threshold to act |
|---|---|---|
| `SQLITE_BUSY` / `database is locked` errors | `logs/app.log` | **Any sustained occurrence** — writes are contending. |
| Chat p95 latency creeping up under load | request timing logs (`[api/chat] finished; total …ms`) | DB-attributable latency > ~50ms/request, or steady climb. |
| Gate query slow | time `tokensUsedByUser()` | > ~20ms, i.e. the per-user `SUM` scan is no longer trivial. |
| `usage_events` row count / DB file size | `data/` file size; admin counts | File > ~1–2 GB, or rows in the tens of millions. |
| Data loss after a deploy | usage resets, gate forgets guests | **Any occurrence** — storage isn't durable. |
| Need read replicas / multi-region | product requirement | When latency-by-geography matters. |

> **Before pulling the trigger on a *symptomatic* one, apply the cheap wins below first** — they
> can push the bottleneck out by an order of magnitude without leaving SQLite.

---

## 2. Buy-time first (cheap wins, stay on SQLite)

These do **not** count as migration; do them when symptom #3/#4 appears (tracked in `KNOWN_BUGS.md`):
- Index `usage_events(userId, createdAt)` — kills the gate's full scan.
- Keep a **running per-user token counter** (one row) instead of `SUM`-ing history per request.
- **Rotate/cap** `usage_events` (it's append-only) — archive or delete beyond the retention window.
- Ensure the DB lives on a **persistent volume**, not container-ephemeral storage.

If these don't hold the line, migrate.

---

## 3. Target choice (decide at trigger time)

| | **Turso / libSQL** (recommended default) | **Postgres** (Supabase / Neon / RDS) |
|---|---|---|
| SQL change | Near-zero — same SQLite dialect | Rewrite SQL + types; richer features |
| Serverless fit | Good (HTTP/edge driver) | Good with pooling (Neon/Supabase) |
| Effort | **Low** — keep most of `db.ts` | Medium |
| When to prefer | Default; fastest exit, keeps our queries | Need advanced relational features, existing PG ops, or strong analytics |

Default to **Turso** unless a product need (complex relational queries, existing Postgres
infra/analytics) justifies Postgres. The decision is contained either way — see §4.

---

## 4. Migration steps (contained by the `UsageStore` / `AlertStore` interfaces)

Because API routes depend on the interfaces in `src/types`, not on `better-sqlite3` (Dependency
Inversion, CLAUDE.md §4), **only the store implementation and its wiring change.** Follow the
mandatory lifecycle (CLAUDE.md §7): plan → test-first → UAT.

1. **Lock the contract with tests.** Write interface-level tests for `UsageStore` / `AlertStore`
   (record, `tokensUsedByUser`, `listSince`, `summarizeSince`, alerts) that run against the
   **current SQLite impl** and pass. These become the acceptance suite for the new impl.
2. **Add the new impl** beside the old: e.g. `TursoUsageStore` / `PgUsageStore` in `src/lib/`,
   implementing the same interfaces. No call-site edits.
3. **Run the SAME test suite against the new impl** — green is the bar (see CLAUDE.md §7.4).
4. **Config switch, not code switch.** Select the impl via env (e.g. `DB_DRIVER=sqlite|turso`)
   at the construction edge (the `new SqliteUsageStore()` lines in the API routes). Document the
   new vars in `.env.example` only (never `.env.local` — the Hard rule).
5. **Backfill the data.** Export existing `alerts` + `usage_events` from SQLite and import into the
   target (one-off script). For the gate, the per-user token totals must carry over or guests reset
   to 0 — decide and state which in the plan. **Never** hand-edit the live `.db` (Hard rule) — read
   via a script the human runs if needed.
6. **Cutover.** Option A (simplest): brief maintenance window, backfill, flip `DB_DRIVER`, deploy.
   Option B (zero-downtime): dual-write to both stores for one release, backfill the gap, then flip
   reads and drop the old write.
7. **Verify in prod** — gate still triggers at the limit, usage dashboard populated, alerts land.
   Then decommission SQLite writes.
8. **Document** — `BUG-FIX-LOG.md` only if a defect was involved; update `SCALABILITY_ISSUES.md` #1
   to `RESOLVED`; note the new driver in `CLAUDE.md` §11.

**Rollback:** the config switch is the rollback — flip `DB_DRIVER` back to `sqlite` and redeploy.
Keep the SQLite file intact until the new store has run clean in prod for an agreed soak period.

---

## 5. Effort estimate

- Cheap wins (§2): ~half a day, stays on SQLite.
- Turso migration (§4): ~1–2 days incl. contract tests + backfill (low risk, SQL mostly unchanged).
- Postgres migration: ~3–5 days (SQL/type rewrite + pooling).

The interface design is what keeps these numbers small — protect it.
