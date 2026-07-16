# PRD — Child Entity & Per-Child Alert Scoping (Phase 2 implementation plan)

**Status:** proposal — ready to build (design settled upstream, not re-opened here)
**Owner:** kidgemini
**Related:** `Ariantra-Platform/docs/PRD-PARENT-AUTH-ALERT-SCOPING.md` §6 (the
child entity), §8 Phase 2 (scope + schema), §13 item 8 (Phase 3's DPDP block —
does not apply to this phase); `Ariantra-Platform/docs/TECH_DEBT.md` #32
(interim posture this phase closes). Phase 1 (per-account PIN) shipped
2026-07-14 — see `src/app/api/parent/pin/route.ts`,
`src/app/api/parent/verify-pin/route.ts`, `src/lib/parent-session*.ts`.

This document is the kidgemini-side build plan for the Phase 2 scope the
platform PRD already specified and the owner already confirmed (2026-07-14,
"schema/design not revisited, only confirmed ready to build"). It does not
re-litigate §6/§8 — it maps that design onto this repo's actual files, adds
the one piece the platform PRD left as "new UI, required" (the active-child
picker), and gives a rollout + test list.

**Non-goal, explicitly:** this phase does not touch the *public game credit*
child concept (`owner-profile-service.ts`, `Ariantra-Platform/TECH_DEBT.md`
#34 — "profile models exactly one child"). That is a different entity for a
different purpose (who a published game is publicly credited to) and lives on
the platform. This phase's `children` table is local to kidgemini, private,
and exists only to scope safety alerts. Conflating the two would couple a
safety feature's schema to a public-credit feature's roadmap for no reason.

---

## 1. What ships

1. A `children` table (kidgemini SQLite) — one row per kid in a family.
2. `alerts` gets two owner columns, backfilled for existing rows.
3. A "who's playing?" picker — the missing write-path input the platform PRD
   flagged as "not an assumption, Phase 2 work."
4. `/api/alerts` filters to the signed-in parent's own children.
5. `/parent` groups alerts per child instead of one flat list.

## 2. Schema & migration

Added to `src/lib/db.ts`'s `getDb()` (same file, same function, matching the
existing `usage_events`/`parent_auth` migration style — `CREATE TABLE IF NOT
EXISTS` + a `PRAGMA table_info` guarded `ALTER TABLE` for the pre-existing
`alerts` table, since SQLite can't add a `NOT NULL` column without a default
in one step but MUST be idempotent on every boot):

```sql
CREATE TABLE IF NOT EXISTS children (
  id          TEXT PRIMARY KEY,
  accountId   TEXT NOT NULL,   -- SSO userId ('user:<email>') — no FK, matches parent_auth's convention
  displayName TEXT NOT NULL,
  ageBand     TEXT NOT NULL,   -- '6-8' | '9-11' | '12-14'
  createdAt   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_children_account ON children(accountId);
```

```sql
-- Guarded, run once per fresh DB (existing DBs get this via the PRAGMA
-- table_info check already used for usage_events' billed* columns):
ALTER TABLE alerts ADD COLUMN ownerType TEXT NOT NULL DEFAULT 'legacy'; -- 'child' | 'device' | 'legacy'
ALTER TABLE alerts ADD COLUMN ownerId   TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_alerts_owner ON alerts(ownerType, ownerId, createdAt DESC);
```

Pre-existing rows land as `ownerType='legacy'` automatically (matches §8
Phase 2: "retained, visible to nobody" — the read-path filter in §6 below
never matches `legacy`, by construction, since it only selects `ownerType =
'child'`).

## 3. Types

New `src/types/child.types.ts` (mirrors `parent-auth.types.ts`'s
interface-first shape):

```ts
export interface ChildProfile {
  id: string;
  accountId: string;
  displayName: string;
  ageBand: "6-8" | "9-11" | "12-14";
  createdAt: number;
}

export interface ChildStore {
  create(input: Omit<ChildProfile, "id" | "createdAt">): ChildProfile;
  listForAccount(accountId: string): ChildProfile[];
  /** Fails closed: returns null if the child doesn't belong to accountId. */
  getOwned(id: string, accountId: string): ChildProfile | null;
}
```

`src/types/alert.types.ts`'s `ParentAlert` gains:

```ts
ownerType: "child" | "device" | "legacy";
ownerId: string;
```

`AlertStore.record()`'s input type picks these up automatically (it's
`Omit<ParentAlert, "id" | "createdAt">`) — every existing call site
(`chat/route.ts:211`, `safety/route.ts:44`) becomes a compile error until it
supplies them, which is the point: no silent unowned write survives Phase 2.

## 4. The "who's playing?" picker

The platform PRD names this as required but leaves the mechanism to this doc.
Three shapes, weighed against the two real call sites that need the value
server-side (`chat/route.ts`'s `alert()` at line 211, `safety/route.ts`'s at
line 44) and the "no blank screens / no friction" UX rule:

| Option | Mechanism | Verdict |
|---|---|---|
| **A — plain cookie, client-set** | Non-httpOnly `kidgemini_active_child` cookie holding a child id; picker component sets it via `document.cookie`; both alert call sites read it server-side through one helper | ✅ **Recommended** |
| B — per-request body field | Every caller of `/api/chat` and `/api/safety` threads `childId` through the POST body | ❌ two call sites, two places to forget it; a dropped field silently mis-attributes rather than failing loud |
| C — server-side "current session" state | A server-tracked "active child" tied to the auth session | ❌ no session store exists beyond the stateless JWT; would need new infra for a non-security value |

**Why non-httpOnly, unlike the guest-identity cookie:** `guestId` is a
security identity (who gets billed/rate-limited) and must resist client
tampering. Which sibling is currently holding the tablet is not a security
boundary — the actual tenancy check is the read-path filter in §6, which
scopes by `accountId` regardless of what the cookie says. A forged or stale
`kidgemini_active_child` value can, at worst, misattribute one alert to a
sibling or to nothing; it can never leak across families, because
`getOwned(id, accountId)` (§3) rejects any id not owned by the signed-in
account before it's used.

**Auto-resolve, no picker shown, for the common case.** Per the "UX is a
feature" rule: most families have one child. `GET /api/parent/children`
returns the account's children; the client:
- **0 children** — no cookie, alerts still fire (`ownerType='legacy'`),
  `/parent` shows an "add your child's profile" prompt (§7) instead of the
  usual per-child alert view. Nothing breaks; it degrades to Phase-1 behavior.
- **1 child** — auto-set the cookie on load, no picker UI at all.
- **2+ children** — a small "Who's playing? [Aarav ▾]" chip in the chat
  header (`src/app/page.tsx` or wherever `ChatPanel` mounts its header),
  persisted in `localStorage` (survives reload without re-asking) and mirrored
  into the cookie on every change so the server side reads the same value.

**Server-side helper** (`src/lib/active-child.server.ts`, mirrors
`parent-session.server.ts`'s shape):

```ts
export async function getActiveChildId(accountId: string | null): Promise<string | null> {
  if (!accountId) return null; // guests never have a child row
  const raw = cookies().get(ACTIVE_CHILD_COOKIE)?.value ?? "";
  if (!raw) return null;
  return children.getOwned(raw, accountId) ? raw : null; // tenancy-checked, not trusted blind
}
```

Both alert call sites become:

```ts
const activeChildId = await getActiveChildId(session?.userId ?? null);
alerts.record({
  ...,
  ownerType: activeChildId ? "child" : session ? "legacy" : "device",
  ownerId: activeChildId ?? (session ? "" : guestId),
});
```

(Signed-in with no child selected still lands as `legacy` rather than
`device` — a signed-in family without a completed child profile isn't a
"device," it's a family that hasn't finished Phase 2 onboarding; keeps the
three `ownerType` values meaning one thing each.)

## 5. Write path

- `src/app/api/chat/route.ts:210-212` — `alert()` closure gains the
  `ownerType`/`ownerId` fields per §4. `session` (from `safeAuth()` earlier in
  the same function) already carries `userId`; no new identity lookup needed,
  just the cookie read.
- `src/app/api/safety/route.ts:44` — same shape; check what identity is in
  scope there today (likely the same `session`/`guestId` pair) and match.

## 6. Read path

`src/app/api/alerts/route.ts` (currently: verified parent → `alerts.list(200)`
global) becomes:

```ts
const account = await getVerifiedParentAccount();
if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
const kids = children.listForAccount(account);
const rows = alerts.listForOwners(
  kids.map((c) => c.id),   // ownerType='child' AND ownerId IN (...)
);
return NextResponse.json({ alerts: rows, children: kids });
```

`AlertStore` gains `listForOwners(childIds: string[]): ParentAlert[]`
(replaces the blind `list(200)` for this route; `list()` can stay for any
other internal caller, or be removed if `/api/alerts` was its only reader —
check before deleting). Zero children → empty result, matching §4's degrade
path. Still `LIMIT 200`, still requires the parent-session cookie (Phase 1
unchanged).

## 7. Onboarding — adding a child

New `POST /api/parent/children` (`{ displayName, ageBand }` → `ChildProfile`),
gated the same way `/api/parent/pin` is: `getAriantraSession()` required,
**no fresh-session requirement** (unlike PIN set/reset, §7 of the platform
PRD — adding a child's display name isn't a credential, doesn't need the
5-minute freshness gate; a stale-but-live parent session is fine here, same
posture as reading alerts). Validate `displayName` (reuse the existing
profanity/length moderation already used for player display names, per §4.1
of the platform PRD) and `ageBand` against the three allowed values.

`GET /api/parent/children` → `listForAccount(session.userId)`.

**UI:** `src/app/parent/page.tsx`'s `alerts` view gains an "Add a child"
card, same visual pattern as the existing "family profile" and "multiplayer"
cards (lines 252-303) — a `card border-l-4 border-brand-300` block. Shown
whenever `children.length === 0`; once at least one exists, the per-child
alert grouping (§8) replaces the flat list, with a small "+ add another"
affordance for 2+-kid families.

**Existing families (already have alerts, no children yet):** lazy prompt on
next `/parent` visit, same rollout shape as Phase 1's PIN interstitial — not
a hard block (alerts still visible as an ungrouped legacy view until they add
at least one child).

## 8. `/parent` UI — per-child grouping

`view.alerts` (currently one flat array) becomes grouped client-side by
`ownerId`, with a heading per child (`children.find(c => c.id === a.ownerId)
?.displayName ?? "Before profiles"` for the legacy bucket) — no new route,
the existing `GET /api/alerts` response from §6 already carries both arrays.

## 9. Security / tenancy

- `getOwned(id, accountId)` is the single trust boundary for "does this child
  belong to this signed-in account" — used by the active-child cookie read
  (§4), the (future, out of scope here) per-child alert-view narrowing
  mentioned in platform PRD §8, and nowhere else needs it.
- The read-path filter (§6) is the actual leak-proofing, independent of what
  any cookie says — matches the platform PRD's own framing ("D4 — every alert
  has an owner, never none" is a data-hygiene rule; the *tenancy* fix is the
  `accountId`-scoped `WHERE`).
- No new credential, no new PIN — Phase 2 rides entirely on Phase 1's
  parent-session cookie for reads and the existing SSO session for writes.

## 10. Testing

Named per the platform PRD §12 items marked "(Phase 2)", plus the ones this
plan's design adds:

- A parent on account A cannot read account B's alerts, by any parameter
  manipulation. *(platform PRD §12, restated for the concrete route)*
- A parent sees Aarav's alerts and Meera's alerts separately, and no one
  else's. *(platform PRD §12)*
- Legacy rows (`ownerType='legacy'`) never appear in any child's grouped view
  or in a zero-children account's response.
- A forged/foreign `kidgemini_active_child` cookie value is silently treated
  as "no child selected" (`getActiveChildId` returns null), never as a write
  into another family's `ownerId` — the write-path equivalent of the read
  leak test above.
- `POST /api/parent/children` rejects a call with no live SSO session (401)
  and does **not** require session freshness (differs from PIN set/reset —
  regression-guard so a future refactor doesn't accidentally import the
  fresh-session check here).
- Single-child family: no picker rendered, first chat message after account
  creation still lands with the correct `ownerId` (auto-resolve path, §4).
- Two-child family: switching the picker mid-session changes which child
  subsequent alerts attribute to, without a page reload.
- Migration idempotency: booting against a pre-Phase-2 DB file twice doesn't
  error and doesn't duplicate the `ALTER TABLE` (mirrors the existing
  `usage_events` migration test, if one exists — add one if not).

## 11. Rollout

1. Ship schema migration + types + `ChildStore`/`AlertStore` changes (no
   behavior change yet — `ownerType`/`ownerId` default to `'legacy'`/`''`
   until the write path is touched; safe to deploy alone).
2. Ship the write-path change (§5) + `/api/parent/children` (§7). At this
   point new alerts start carrying real owners for any family that has added
   a child; families that haven't yet still get `legacy`.
3. Ship the read path (§6) + `/parent` grouped UI (§8) + the picker (§4)
   together — a family with alerts but no child profile must not lose the
   dashboard (same caution the platform PRD calls out in its own §11 step 2).
4. Existing-family lazy prompt goes live with step 3; no separate flag needed.

## 12. Out of scope (this phase)

- Phase 3 (server-side conversation transcripts scoped per child) — blocked
  on the DPDP opinion, tracked in `Ariantra-Platform/docs/TECH_DEBT.md` (new
  entry, registered alongside this doc). Nothing here unblocks or needs it.
- `consent_records` (platform PRD §10) — deliberately not built now; the
  `children` table above doesn't foreclose adding it later (a child row is
  exactly where a future consent record would hang off).
- Public game-credit multi-child support (`TECH_DEBT.md` #34, platform-side,
  different entity — see the non-goal note at the top of this doc).
- Per-child usage/screen-time limits — that's `PRD-SCREEN-TIME.md`'s scope
  (a sibling, unrelated tracking system), not this one.

## 13. Open decisions

1. **Picker placement** — this doc recommends a chat-header chip (§4); could
   also live inside the existing hamburger/sidebar. Cosmetic, decide during
   build against current header real estate.
2. **`listForOwners` vs. narrowing `list()`** — whether to add a new
   `AlertStore` method (recommended, §6) or overload the existing one; check
   for other `list()` callers first (§6 note) before deciding.
3. **Deleting a child profile** — not specified upstream or here. A family
   that adds a child by mistake has no delete path in this plan. Small
   addition if UAT surfaces the need; not blocking initial ship.
