# PRD — The Sparks page shows the money side (2026-08-27)

**Owner decisions (2026-08-27):** EVERYONE sees it (kids and parents — revises
the 2026-07-25 "kids see no balance / no deductions" rule); whole-Spark
rounding; costs are shown AFTER the ask (an ESTIMATE before is scoped for
later, §6); it lives on the **Sparks page** (the ⚡ Sparks tab next to
Games-Lab → `/wallet`), **not in the chat window**.

## 1. Problem

The Sparks tab only showed awarded Sparks. Nowhere could a kid or parent see
what is available, what has been used, which chat is eating the balance, or
what a single request cost.

## 2. What ships (all on `/wallet`, `WalletPanel`)

| Section | Shows | Source |
|---|---|---|
| **Your Sparks** | ⚡ available · ⚡ used · ⚡ added | platform parent statement via `GET /api/sparks/usage` |
| **What each chat used** | one row per chat, newest first, `⚡ N` | our chat store, summed in SQLite (`sparksByConversation`) |
| tap a chat | each request's text + `⚡ N` (or "not counted") | `GET /api/sparks/usage?chat=<id>` → `sparksAsks` |

Nothing changes in the chat window, sidebar or header.

## 3. Data flow (no platform change)

1. `api/chat/route.ts` already sends one debit per model call. The platform's
   answer is `{ charged, balance, gauge }`. `billSparks` now RETURNS it.
2. AFTER the `done` frame (the reply is never held back) the route waits a
   bounded moment (`SPARKS_RECEIPT_WAIT_MS`, default 2500) and emits ONE
   `{ type: "sparks", charged }` frame (`sparks-receipt.ts`). Silent platform
   ⇒ no frame, no delay.
3. The client records `charged` as `ChatMessage.sparks` on the reply; the
   chat-history whitelist (`cleanMessage`) lets that field through so it
   persists with the chat.
4. The Sparks page reads: ledger totals from the parent statement
   (`summarizeStatement`: balance / Σdebits / Σcredits) and per-chat /
   per-request numbers from `conversations.messages` via `json_each` — the
   game HTML never leaves SQLite to add up numbers.

## 4. Files

- `src/lib/sparks-receipt.ts` · `src/lib/sparks-display.ts` (`formatSparks`,
  `summarizeStatement`) · `src/lib/sparks-bridge.ts` (returns the receipt)
- `src/app/api/chat/route.ts` (collect + emit) · `src/types/chat.types.ts`
  (`ChatMessage.sparks`) · `src/lib/chat-history.ts` (whitelist)
- `src/lib/db.ts` (`sparksByConversation`, `sparksAsks`)
- `src/app/api/sparks/usage/route.ts` · `src/components/WalletPanel.tsx`

Tests: `sparks-receipt.test.ts` SR.1–5 · `sparks-display.test.ts` D.1–6 ·
`sparks-bridge.test.ts` R.1–2 · `api/chat/route.test.ts` SP.1–3 ·
`chat-history.test.ts` SK.1–2 · `db.sparks-usage.test.ts` U.1–4 ·
`api/sparks/usage/route.test.ts` SU.1–4 · `components/sparks-page.test.ts`.

## 5. Scale ceilings / known gaps (revisit triggers)

- **Fan-out losers under-report per request.** `kind:"fallback"` debits are
  sent after the response streamed, outside the receipt window. The ledger
  totals (available / used) are exact regardless. Trigger: losers >10% of
  turns → persist receipts server-side by replyId and reconcile.
- **Ledger totals read the full parent statement** (≤200 rows) because no
  `{ balance: true }` partner call exists. Once per page load. Trigger: add
  the light call on the platform when latency shows in logs.
- **`json_each` walks every message of every chat** (≤500 chats) per page
  load. Trigger: slow-query log → denormalised `sparks` column.
- **Replies older than this feature show "not counted"** — honest, not
  back-filled; the ledger totals still include them.
- **"Open this chat" from the Sparks page** is not offered: `/?chat=` is only
  a deep-link together with `edit=` (edit-entry.ts). Add a plain chat
  deep-link first if wanted.

## 6. Later (scoped out today)

- Estimate BEFORE the ask ("about 15 ⚡").
- Server-persisted receipts (loser-inclusive, reload-safe).
