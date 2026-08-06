# PRD — Share a Conversation (parent-gated secret link)

**Date:** 2026-08-06 · **Status:** BUILT same day (v1) · **Owner decision:**
parent-gated secret link (chosen over PIN-less links and share-sheet-only
export when the ⋮ menu shipped).

A kid can share a chat with Ari as a **read-only web page** at an unguessable
link — after a grown-up approves with the parent PIN. Revocable any time from
the same menu.

## Why

The sidebar ⋮ menu (2026-08-06) shipped Rename + Pin; Share was the third ask.
Unlike a published game, a transcript is the kid's own words — so creation
goes through the same parent gate as publishing, and the page is text-only.

## Tech Feasibility

- **Storage:** one nullable `shareToken TEXT` column on `conversations`
  (PRAGMA-guarded ALTER, same pattern as `deletedAt`/`pinnedAt`) + an index
  for the public lookup. NULL = not shared. Token = 32-hex `randomBytes(16)`
  — unguessable, same trust model as the 2-hour game test link, but
  long-lived until revoked.
- **Parent gate:** already exists — `/api/parent/verify-pin` mints the
  HttpOnly `ari_parent` cookie; `getVerifiedParentAccount()` checks it
  (identical to publish, PRD-PARENT-AUTH-ALERT-SCOPING §8). No new auth code.
- **Public read:** ONE new unauthenticated query, keyed by token only
  (`deletedAt IS NULL AND shareToken = ?`). Deleting or revoking kills the
  page instantly. `noindex` — a secret link must never end up in a search
  engine.
- **Rendering risk:** transcripts carry `artifactHtml` (model-generated game
  code). The share page NEVER renders it — games show as a "🎮 built a game
  here" chip. Text-only page = no script execution surface.

## Tech Plan

1. `db.ts`: migration + `setShareToken(userId, id, token|null)` (fail-closed
   owner + not-deleted), `getShareToken(userId, id)`,
   `getSharedByToken(token)` → `{title, messages, updatedAt}`.
2. `POST /api/chats/:id/share` — requires the chat owner identity AND a
   PIN-verified parent session; idempotent (returns the existing token if one
   is live). `DELETE` — owner-only revoke (reducing exposure needs no PIN).
3. `/share/chat/[token]` — server-rendered read-only transcript, 404 on
   unknown/revoked/deleted, `robots: noindex`.
4. UI: `ShareChat.tsx` bottom sheet (PIN step → link + copy/share + "Turn off
   the link"), launched from the sidebar ⋮ menu via `onShare`.
5. Tests: store round-trip/fail-closed/revoke (db.chat-history H.23+), route
   gates (share.route.test.ts — no parent session → 403, foreign id → 404,
   revoke kills the public read), UI source pins.

## Use Cases — all of them

1. **Kid shares with grandma** — Share → grown-up types PIN → link → WhatsApp.
   Grandma opens the page signed-out, reads the chat, sees game chips (not
   playable code). *Tackled by:* the public page + share sheet.
2. **Parent revokes** — ⋮ → Share → "Turn off the link" (no PIN needed;
   revoking only reduces exposure). Old link → 404 page with a friendly
   explanation. *Tackled by:* DELETE + token check in the page query.
3. **Kid tries to share without a grown-up** — PIN step blocks; lockout
   policy is the existing escalating one. *Tackled by:* `verify-pin` reuse.
4. **Wrong/guessed link** — 32-hex token, unguessable; unknown token → 404,
   no existence oracle. *Tackled by:* token-only lookup.
5. **Chat deleted after sharing** — soft delete already hides the row; the
   share query filters `deletedAt IS NULL`, so the page dies with the chat.
   *Tackled by:* shared WHERE clause.
6. **Re-share after revoke** — a fresh POST mints a NEW token (the old link
   stays dead). *Tackled by:* idempotency only applies to a LIVE token.
7. **Guest kid (no account)** — guests have chat identity but the PIN gate
   requires a signed-in family with a PIN set → the sheet shows the same
   "ask a grown-up to sign in" step as publish. *Tackled by:* verify-pin's
   session requirement.

## Scale ceiling

Token lookup is indexed; pages are SSR-on-demand with no caching — fine for
family-scale sharing. If a shared chat ever goes viral (>10 req/s sustained),
add an ISR cache on the page. Not before.
