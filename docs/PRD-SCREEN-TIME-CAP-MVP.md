# PRD — Daily Screen-Time Cap + Parent Alert (MVP)

Status: **implemented 2026-07-15** (this doc reviewed against code).
Related: `Ariantra-Platform/docs/PRD-SCREEN-TIME.md` (the full proposal this
is a deliberately minimal slice of — registration/login overhaul, guest
15-min wall, cross-surface tracking — none of that is here, see §5).

**Changed same-day (2026-07-15, real-usage UAT):** v1 derived minutes purely
from chat-message timestamps — deliberately, to avoid a new heartbeat client.
Real testing showed the gap: a kid playing an already-built game (no new
chat messages) produced zero signal, so "screen time" read 0 despite genuine
use. Added a lightweight client heartbeat (§2.1) so play time counts the
same as chat time. The "no heartbeat" scope decision in §3 is **reversed**;
everything else in this doc is unchanged.

## 1. Problem

A parent asked for "the timer for kids, and the timer should be controlled
by parents" — a way to know (and cap) how long their kid spends in
kidgemini, without building the much larger screen-time system the platform
PRD proposes.

## 2. Solution (what shipped)

1. **Minute-derivation** (`src/lib/screen-time.ts`, pure, unit-tested):
   `deriveActiveMinutes()` sums gaps between consecutive presence timestamps
   (`screen_time_pings`, §2.1), each gap capped at 5 minutes, plus a flat
   2-minute tail after the last event.
2. **Presence pings** (§2.1 detail): one row per chat completion (immediate,
   so a short session counts before the first heartbeat tick) AND one per
   client heartbeat tick (`ScreenTimeHeartbeat.tsx`, mounted in the root
   layout) — a `POST /api/screen-time/heartbeat` fired every 60s while the
   tab is open and `document.visibilityState === "visible"`, whether the kid
   is chatting or playing a generated game in the preview iframe (the iframe
   doesn't trigger `visibilitychange` — only an actual tab switch/minimize
   does). Signed-in only; a guest ping is a silent no-op, not an error.
3. **Storage** (`src/lib/db.ts`, three new tables): `screen_time_settings`
   (one row per account — the parent's cap), `screen_time_daily` (one row
   per account per UTC day — the cached tally + alert-debounce stamp), and
   `screen_time_pings` (the raw presence timestamps §2 derives from, pruned
   to a 2-day retention window on write — only "today" is ever queried).
   `SqliteScreenTimeStore.recomputeAndMaybeAlert()` recomputes the day's
   tally on every ping (chat completion or heartbeat) and fires the alert
   exactly once per account per day.
4. **Alert integration**: a cap-crossing writes into the SAME `alerts` table
   parent-safety alerts already use (`ParentAlert.origin: "system"`,
   `severity: "low"`, `action: "allow"` — nothing is blocked), visible in the
   existing `/parent` alerts list.
5. **Parent control** — `GET/POST /api/parent/screen-time`, gated by the
   same PIN-verified parent-session cookie as `/api/alerts` (no freshness
   requirement — a number isn't a credential). Card on `/parent` ("⏱️ Daily
   screen-time alert"): today's minutes, the currently-saved cap shown
   separately from the edit field, a cap input, Save with an explicit "✓
   Saved" confirmation (added same day — a silent success left the parent
   with no idea it worked).
6. **Kid-appropriate signup** (Ariantra-Platform, not this repo): a kid
   arriving at the platform's signup flow from kidgemini's guest wall now
   sees "Create your Ariantra account" instead of "Create a creator
   account," with the child's name/age required alongside the
   already-required parent contact — see
   `Ariantra-Platform/src/lib/auth/return-to.ts`'s `isKidgeminiReturnTo()`.

## 3. Scope decisions (explicit — don't silently expand this later)

- **One account per family**, same as today's parent-PIN model. A "child"
  for this feature is the existing signed-in kidgemini SSO account — no new
  child entity, no "who's playing?" picker, no separate parent/child logins.
  (A genuinely separate parent↔child account link was considered and
  explicitly rejected — it would have required redesigning the
  already-shipped parent-PIN system.)
- **Alert-only.** No hard lock, no nudge/countdown. Crossing the cap writes
  one alert; nothing about the chat response changes.
- **No kid-facing UI at all.** Silent tracking; only the parent sees or sets
  anything.
- **kidgemini-local only.** No platform/Mongo/Redis involvement, no
  cross-surface (catalog, published games) time tracking — just this app's
  own SQLite.
- **Heartbeat is presence-only, not a new tracking system.** ~~No new
  heartbeat/visibility-tracking client~~ **reversed 2026-07-15** — a
  lightweight client heartbeat exists (§2.1), but it carries no payload
  beyond "this account is here right now": no page/route, no keystroke or
  content data, nothing beyond a timestamp. Still no cross-surface reach —
  only kidgemini's own tab.

## 4. Data model

```sql
CREATE TABLE screen_time_settings (
  accountId TEXT PRIMARY KEY,
  dailyCapMinutes INTEGER,       -- NULL = no cap set
  updatedAt INTEGER NOT NULL
);
CREATE TABLE screen_time_daily (
  accountId TEXT NOT NULL,
  dayStart INTEGER NOT NULL,     -- UTC midnight, epoch ms
  activeMinutes INTEGER NOT NULL DEFAULT 0,
  alertedAt INTEGER,
  updatedAt INTEGER NOT NULL,
  PRIMARY KEY (accountId, dayStart)
);
-- Raw presence timestamps screen_time_daily.activeMinutes is derived from —
-- one row per chat completion or heartbeat tick. Pruned to 2 days on write.
CREATE TABLE screen_time_pings (
  accountId TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);
```

## 5. Explicitly out of scope (tracked upstream, not forgotten)

Everything in `Ariantra-Platform/docs/PRD-SCREEN-TIME.md` beyond the above:
child registration/login as its own flow, the guest 15-minute forced
sign-in wall, cross-surface (catalog + games) heartbeat tracking centralized
on the platform, hard-lock enforcement, and a full multi-child family
dashboard. If any of those become the actual ask, start from that PRD, not
this one.

## 6. Testing

| File | Pins |
|---|---|
| `src/lib/screen-time.test.ts` | `deriveActiveMinutes` edge cases; `utcDayStart` UTC-midnight snapping |
| `src/lib/db.screen-time.test.ts` | settings round-trip incl. clearing; recompute derives minutes from recorded pings; a single ping (short session) still counts; pure-gameplay pings (no chat) accrue the same way; alert fires exactly once/day; new day resets eligibility; no cap never alerts; a ping from a prior day never counts toward today; `recordPing` prunes past the retention window |
| `src/app/api/screen-time/heartbeat/route.test.ts` | guest → 200 no-op, no tracking; signed-in → records a ping + triggers recompute; falls back to email when no display name; a thrown store error fails open (still 200) |
| `src/app/api/parent/screen-time/route.test.ts` | 401 unauthenticated; GET reflects saved state; POST validates (422 on bad values, 400 on missing field); round-trips through GET |
| extend `src/app/api/chat/route.test.ts` | signed-in completion records a ping AND triggers recompute; guest does neither; a thrown error fails open (chat still succeeds) |
| `Ariantra-Platform/src/lib/auth/return-to.test.ts` | `isKidgeminiReturnTo` host-detection (prod + dev, positive + negative cases) |
| manual UAT (no component-test harness exists for the heartbeat's client wiring — `ScreenTimeHeartbeat.tsx` is DOM/timer wiring, untested at the unit level, matching this repo's existing convention for page-level components) | sign in from kidgemini's guest wall → kid-framed signup, child fields required; set a low cap → chat past it → exactly one alert + "✓ Saved" confirmation; second turn same day → no duplicate; clear cap → no more alerts; **play an already-built game without chatting → minutes still accrue** (the real gap this heartbeat fixes) |
