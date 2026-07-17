# Data Handling

What's stored, where, for how long, and who can read it. Started 2026-07-17
from a code-audit finding (see `docs/BUG-FIX-LOG.md` same date) — this
documents CURRENT behavior; it does not itself change anything. Retention
period is flagged below as an open product decision, not resolved here.

## What's retained, and where

Every chat turn and repair call writes a row to SQLite's `usage_events` table
(`src/lib/db.ts`, `SqliteUsageStore.record`), including:

- `requestText` — the kid's full message (or, for a repair call, the failure
  code being repaired)
- `outputText` — the model's full reply, including generated game HTML/JS
  (repair calls truncate this to 4,000 chars; chat does not)
- `userId`, `userLabel`, geo fields (`ip`, `country`, `region`, `city`), token
  counts, cost estimate

This is a full-fidelity, indefinite, un-redacted record of what a child asked
for and what the AI generated for them, on a children's product.

## Who can read it

`GET /api/usage` (`src/app/api/usage/route.ts`) — gated by `ADMIN_SECRET`
compared via `timingSafeEqual` (correctly constant-time). With `?detail=true`
it returns the raw `requestText`/`outputText` for matching rows, in bulk.
Anyone holding `ADMIN_SECRET` can pull any kid's full chat history this way.

## Retention period — open decision, not yet set

There is currently **no expiry, no automatic purge, and no redaction** —
rows persist indefinitely. This is an explicit gap, not an oversight to fix
inline: setting a retention window (e.g. purge raw text after N days, keep
only aggregate token/cost counts) is a product/legal decision for a
children's product, not something to decide as a side effect of an
error-handling pass. **Trigger to revisit:** before this product handles
data for children outside a jurisdiction/relationship where "we just keep
everything" is acceptable, or on the first parent/regulator question about
retention.

## Related

- `docs/BUG-FIX-LOG.md` (2026-07-17 entry) — the audit finding that surfaced
  this as needing an explicit decision.
- `src/app/api/usage/route.ts` — the admin read path described above.
