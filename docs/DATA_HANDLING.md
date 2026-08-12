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

## Community Help tickets (added 2026-07-28, Phase 1)

`help_tickets` and `help_replies` (`src/lib/db.ts`, `SqliteHelpStore`) hold what
a stuck child sent to a human, plus what the human sent back:

- `reasonCode` — one of six fixed picture reasons; never free prose
- `transcript` — the child's own words, ONLY when they used 🎤 Something else
- `errorReport` — `buildErrorReport()` output, bounded to 4,000 chars and by
  construction free of generated game source (`src/lib/error-report.ts`)
- `verifyVerdict`, `conversationId`, `messageId` — the diagnosis and an artifact
  *reference*; the game's HTML is never stored on the ticket
- `help_replies.body` — the exact text an adult sent to a child, with
  `cannedId` marking whether it came from the reviewed library
  (`src/lib/help-canned.ts`) or was typed by hand

**Deliberately NOT carried:** the generated game, and the chat history. Loading
a game's source is a separate admin action that writes a `help_audit` row
(`action = 'load_source'`) — it is never fetched implicitly with a ticket.

**Who can read it:** the child (own tickets only, `GET /api/help`, and never the
answering admin's identity); the parent (`GET /api/parent/help`, behind the
PIN-verified parent session — every reply ALSO writes a `ParentAlert` so it
surfaces in the alerts list without opting in); an operator holding
`ADMIN_SECRET` (`POST /api/admin/help`). Tenancy is enforced per statement,
writes included — a valid ticket id belonging to another identity is refused.

**Retention, narrower than the rest of this document:** `pruneClosedText(now)`
drops `transcript` and `errorReport` 30 days after a ticket is closed
(`PRUNE_TEXT_AFTER_MS`, `src/lib/help.config.ts`), keeping the structured row —
the analytics value is in the reason codes and timings, not the text. The
*structured* rows still inherit the indefinite-retention posture below, so this
feature slightly enlarges that open question rather than answering it. The prune
runs on every ticket write (same sweep-on-write idiom as `turn_results.start()`
and `recordPing()`), so there is no scheduler to forget.

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

## Where a child's prompt can be SENT — open decision per provider

Retention above is about our own store. This is the other half: which third
parties a child's words reach. Today, in production, the answer is **Google
only** — either AI Studio or Vertex AI express, selected by `GEMINI_BACKEND`
(`src/lib/google-backend.ts`). Both are the same vendor and the same data
posture; the switch is transport, not destination. Note Vertex bills and logs
against a GCP project rather than the AI Studio key, so the *account* holding
those request logs changes when it is flipped.

Two catalogued providers are **China-based** and would send a child's prompt
outside that arrangement:

- **Moonshot (Kimi)** — catalogued 2026-07-20
- **DeepSeek** — catalogued 2026-08-12

Both are held shut by two independent gates: their API key is unset, AND they
are `prompt-only` so `ALLOW_PROMPT_ONLY_SAFETY_MODELS=1` is also required
(`src/lib/model-registry.ts`). Neither has ever served a turn. **Trigger to
revisit:** before either key is set on any box that serves real children —
enabling them is a privacy/compliance decision on top of the safety-floor one,
and the two are separate approvals.

## Related

- `docs/BUG-FIX-LOG.md` (2026-07-17 entry) — the audit finding that surfaced
  this as needing an explicit decision.
- `docs/2026-08-12_PRD_VertexBackendAndDeepSeek.md` — the backend switch and
  the DeepSeek gates described above.
- `src/app/api/usage/route.ts` — the admin read path described above.
