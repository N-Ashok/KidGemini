# Code review — 2026-07-14 working-tree diff

Working checklist from an `xhigh`-effort multi-pass review of the uncommitted diff
(catalog doubling 50→100 + mic-repeat fix + billing/usage-metering overhaul +
admin dashboard panels). 14 findings, ranked most-severe first. Check off as fixed;
each fix still needs a regression test + `docs/BUG-FIX-LOG.md` entry per `CLAUDE.md` §9.

Cross-file note: findings 1, 2, 4, 6 are all instances of the same **cost-undercounting
class** in `src/lib/gemini.ts`'s hedge/fallback streaming — worth fixing together, see
"Suggested approach" at the bottom.

---

## Billing / usage-metering cluster (`src/lib/gemini.ts`, `src/app/api/*/route.ts`, `src/lib/db.ts`)

- [ ] **1. Mid-stream model death loses that model's already-billed tokens (general case)**
  `src/lib/gemini.ts:478`
  The outer `catch`'s `for (const s of srcs) abandon(s);` discards `src.usage` for
  *any* source that dies mid-stream — not just hedge losers. A primary model that
  streams several chunks (real, billed `usageMetadata` accumulating on each) and then
  dies before reaching `done` has that usage silently dropped when the chain falls
  back to the next model. Google already billed for those tokens; the dashboard
  never sees them. **CONFIRMED**

- [ ] **2. `servedModel` never updates when the serving model emits no `usageMetadata`**
  `src/lib/gemini.ts:425`, `src/app/api/chat/route.ts:230,258,302`
  `servedModel` starts at the primary (`chatModelName`) and only changes inside the
  `chunk.kind === "usage"` branch. A fallback model whose stream completes with zero
  `usageMetadata` chunks (a real, already-tested case — `gemini.usage.test.ts` U.2)
  leaves `servedModel` pinned to the primary — the turn gets costed/logged at the
  wrong model's rate (rates can differ 15x). **CONFIRMED**

- [ ] **3. DB migration is non-atomic; a crash mid-migration can brick usage recording**
  `src/lib/db.ts:146`
  The 4-column `ALTER TABLE` + backfill `UPDATE` run as one `db.exec()` call with no
  transaction wrapper (confirmed non-atomic in better-sqlite3's native impl). The
  idempotency guard checks only the first new column (`billedPromptTokens`). A crash
  between statements (plausible: the 350MB pm2 restart cap) can permanently skip the
  rest of the migration — and since `record()`'s INSERT unconditionally references
  all 4 columns, every subsequent chat/repair request then throws `no such column`
  until a human manually patches the schema. **CONFIRMED**

- [ ] **4. Partial `usageMetadata` silently records 0 tokens instead of falling back to the estimate**
  `src/lib/gemini.ts:42-43`
  `usageChunk()` defaults any *individually* missing field to `0`, not `undefined`.
  `route.ts`'s `real?.outputTokens ?? outputTokens` only falls back to the
  char-estimate when the whole `real` object is absent — `0 ?? outputTokens` is
  still `0`. A real-but-partial usageMetadata (e.g. `promptTokenCount` present,
  `candidatesTokenCount` missing) silently bills `outputTokens: 0` for a turn that
  streamed a full reply. Same `??` pattern duplicated in `src/lib/db.ts:192`.
  **CONFIRMED**

- [ ] **5. Repair route's default model string doesn't match what `GeminiChatModel` actually uses**
  `src/app/api/repair/route.ts:61` vs `src/lib/gemini.ts:225`
  route.ts defaults `model` to `"gemini-2.5-flash"`; `GeminiChatModel`'s own default
  (the one `.repair()` actually calls with — it takes no model param) is
  `"gemini-3-flash-preview"`. Whenever `GEMINI_CHAT_MODEL` is unset, every repair
  call is priced and labeled under the wrong model. **CONFIRMED**

- [ ] **6. Hedge-race loser's already-billed usage is dropped**
  `src/lib/gemini.ts:453`
  When a hedge race resolves, `abandon()` fire-and-forgets every losing source
  without reading its accumulated `usage` first. Hedges fire exactly when Google is
  overloaded — both racers are real, billed API calls, but only the winner's tokens
  are ever recorded. Distinct from the existing documented "chat-failed streams
  aren't recorded" gap: the loser here didn't fail, it was cancelled by our own
  logic. **CONFIRMED**

**Suggested approach for 1/2/4/6 together:** they're all instances of "a `Src`'s
accumulated usage/model identity can be lost between when it's known and when it's
recorded." Consider recording `usage` (even if `undefined`) alongside the model name
on every abandon/catch path — e.g. a small `recordAbandoned(src)` hook called from
both `abandon()` sites and the outer `catch`, folded into `costUsd` as a
supplementary line, or surfaced as a distinct `kind:"chat-partial"` usage event —
rather than patching each of the 4 call sites independently.

---

## Mic-dictation fix (`src/components/useSpeechInput.ts`)

- [ ] **7. `committedFinalsRef` resets before confirming `rec.start()` actually restarted**
  `src/components/useSpeechInput.ts:162` (and the `onend` auto-restart, ~136)
  Both reset the counter to 0 *before* calling `rec.start()`, whose "already started"
  failure is silently swallowed by the surrounding `catch`. If the browser session
  didn't actually restart (e.g. `Composer.tsx`'s `handleRestart()` racing its fixed
  150ms gap against real stop-latency), the counter is desynced from the still-live
  session's internal results list — risking the exact repeat bug this diff fixes,
  via a different trigger. **PLAUSIBLE** (mechanism confirmed; real-device trigger
  timing not independently reproduced)

---

## Asset catalog (`src/lib/assets/*.ts`)

- [ ] **8. Admin dashboard double-counts guest→signed-in conversions in "Est. unique people"**
  `src/app/admin/page.tsx:35`
  `estUnique()` sums `signedInUsers + Math.min(guestBrowsers, guestDevices)` — but
  the panel's own caption says not to sum these ("a guest who later signs in is
  counted once in each column"). No code relabels old guest rows on sign-in, so a
  same-window guest→account conversion is counted twice in the headline figure.
  **CONFIRMED**

- [ ] **9. "By day" table (UTC) and new period cards (IST) disagree on "today"**
  `src/lib/db.ts:404`
  `summarizeSince`'s `byDay` bucketing (`toISOString().slice(0,10)`, UTC) was left
  untouched while new IST-aware rollup cards were added alongside it on the same
  /admin page. They visibly disagree on totals during UTC 18:30–24:00 (IST
  00:00–05:30) every day. **CONFIRMED**

- [ ] **10. Racing/driving genre trigger misses "go kart" (two words) and bare "tracks"**
  `src/lib/assets/model-select.ts:26`
  `go-?karts?` doesn't allow a space, and `track` has no `s?`. Regex-tested: "make me
  a go kart game" and "build me some tracks" both fail to match any alternative —
  the genre (and its new race-track/gokart models) never fires for these common
  phrasings. **CONFIRMED**

- [ ] **11. Kid-facing gallery trigger text has grammar typos: "cherriess", "strawberrys"**
  `src/lib/assets/gallery.ts:145`
  `plural()`'s `IRREGULAR_PLURALS` map has no entry for "cherries" (already plural)
  or "strawberry" (irregular y-plural), so it naively appends "s" to both. Verified
  by running `galleryCards()` against the shipped manifest — shown verbatim to kids
  as "Say '3d cherriess' to use this!" on the assets page. **CONFIRMED**

---

## Documentation accuracy / conventions

- [ ] **12. BUG-FIX-LOG claims "18/18 passing" for a test file that has 13 tests**
  `docs/BUG-FIX-LOG.md` (2026-07-14 mic-repeat entry) + `docs/REGRESSION-TEST-CATALOG.md`
  `npx vitest run src/lib/speech-transcript.test.ts` → 13 passed, 13 total. The log
  entry (which `CLAUDE.md` §9 treats as part of the deliverable) overstates coverage
  by 5 tests. **CONFIRMED**

---

## Scalability / cleanup (lower priority, fix opportunistically)

- [ ] **13. `repeatUsersSince(0)` is an unbounded, unindexed full-table scan on every /admin load**
  `src/app/api/usage/route.ts:69`
  No `LIMIT`, no index covering the computed IST-date expression, always called with
  `sinceMs=0` regardless of the dashboard's window selector. Not yet documented in
  `docs/SCALABILITY_ISSUES.md` (CLAUDE.md §10 requires it before shipping an
  unbounded query). Low urgency today (admin-only, low traffic) but grows with
  `usage_events`, which is never rotated.

- [ ] **14. IST offset duplicated as a magic SQL literal instead of reusing `period.ts`'s constant**
  `src/lib/db.ts:330` vs `src/lib/period.ts:6`
  `repeatUsersSince` hardcodes `'+330 minutes'` in raw SQL; `IST_OFFSET_MS` in
  `period.ts` names the same fact but isn't exported. Three independent review passes
  flagged this convergently. Low risk (IST has no DST) but two disconnected sources
  of truth for the same constant.

---

*Generated from the `/code-review` xhigh-effort pass (10 finder angles → verification
→ gap sweep) on the working-tree diff as of 2026-07-14. Re-run `/code-review` after
fixes land to confirm nothing regressed.*
