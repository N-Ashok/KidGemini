# Known Bugs & In-Progress

> **Past fixes:** see `docs/BUG-FIX-LOG.md`. Add an entry there whenever a fix lands.
> Statuses: `TODO` · `IN PROGRESS` · `WATCHING` · `DONE (needs UAT)` · `FIXED`.

| # | Issue | Status | Details |
|---|-------|--------|---------|
| 6 | Sign-in on a local build jumped to production Studio, losing the local draft | FIXED 2026-07-23 | **Done** (`BUG-FIX-LOG.md` 2026-07-23). Making a game while logged out then signing in bounced the user from `localhost` to `https://studio.ariantra.com` — and prod's `safeReturnTo` then rejected the localhost `returnTo`, stranding them there with the local draft gone. Root cause: `useAriantraSession.tsx` chose the login origin from **build-time** `process.env.NODE_ENV`, which is `"production"` for any locally-served prod build (`next start`). Fixed by resolving the origin at click time from the live `window.location.hostname` (`src/lib/login-url.ts`, `resolveLoginUrl`); tests `login-url.test.ts` L.1–L.5. |
| 5 | `search_not_found` / `inSource=false` — asset injection strips markers the model re-emits in SEARCH | WATCHING 2026-07-20 | **Root cause found + fixed for the common case** (`BUG-FIX-LOG.md` 2026-07-20, second entry). The two earlier hypotheses (history-trim; `source=newest` pin race) were WRONG. The real mechanism: `injectAssets` REMOVES the `<!--USES_MODELS: …-->`/`USES_THREE`/`USES_AUDIO` markers from the delivered game (they become an import map + `AR_ASSETS`), so the STORED source has no markers — but the 3D/asset prompt tells the model to always emit them, so it re-writes them into its SEARCH block, which is then by construction absent from the source we patch. **Fix landed:** `reconcileAssetMarkers` (game-edit.ts) strips the markers out of the reply the same way injection stripped them from the source and re-applies, guarded so it can only rescue a failed patch and never regress a new-asset add; `markers.ts` new; tests `game-edit.reconcile.test.ts` A.1–A.7, `markers.test.ts` M.1–M.9. **Still WATCHING:** a SEARCH that also spans the injected `<head>` region won't match on marker-strip alone. The new `afterMarkerStrip=` flag on the miss log line distinguishes the (rescuable) marker mechanism from anything else — a prod streak with the fix deployed confirms the residual is small before this closes. |
| 4 | `finishReason` is never inspected, so an empty completion's CAUSE is invisible | FIXED 2026-07-20 | **Done** (`BUG-FIX-LOG.md` 2026-07-20). `finishReason` is now surfaced on `ProviderChunk` (`normalizeFinishReason` in gemini.ts) and the streaming runner branches on it: (a) **SAFETY** (plus sibling block reasons PROHIBITED_CONTENT/BLOCKLIST/SPII) throws a terminal `SafetyBlockedError` — the chain does NOT walk to bypass a child-safety block, and the route turns it into a kind redirect + a parent alert (fail closed); (b) **MAX_TOKENS** retries the SAME model ONCE with a halved thinking budget before walking; everything else still walks as a plain dud slot. Tests `gemini.finish-reason.test.ts` FR.1–FR.5, `route.test.ts` safety-block. **Note:** the MAX_TOKENS retry is unproven against real traffic until logs show MAX_TOKENS actually occurs (finishReason was invisible before this) — the reduced-budget heuristic (halve) may want tuning once seen; SAFETY fail-close is the definite, safety-critical part. |
| 3 | "📲 More…" share button fake-confirms where `navigator.share` doesn't exist | TODO 2026-07-18 | Same "thanks without sharing" class as the WhatsApp share bug fixed the same day (`BUG-FIX-LOG.md` 2026-07-18): in `PublishToArcade.tsx`, `parent/page.tsx` (and platform's `CatalogClient.tsx`/`share-overlay.ts`), the `else` branch when `navigator.share` is missing (desktop Firefox, older Chrome) flips straight to "Nice! Thanks for sharing." without sharing anything. Fix: hide the button when unsupported (needs a mounted-state check to stay hydration-safe), or fall back to copy-link + a "link copied" confirm. |
| 2 | Payment rails landed; entitlement gate not wired | IN PROGRESS 2026-06-26 | **Rails shipped** (Razorpay one-time Orders + Checkout): `/upgrade` page, `POST /api/billing/order\|verify\|webhook`, `GET /api/billing/status`, signature verification (`src/lib/razorpay.ts`), and `payments`/`webhook_events` tables. A paid order stamps `periodEndsAt` but **nothing is gated on it yet** ("rails only", per the 2026-06-26 product decision — see `docs/PRD.md` §8a). **Still owed:** (a) an `entitlement(userId)` check + a real gate (e.g. a monthly free-turn cap that paid accounts bypass); (b) migrate to recurring **Subscriptions** (needs Razorpay Plans created) if recurring billing is wanted; (c) manual UAT of live Checkout with real keys. Earlier "Upgrade — coming soon" prompt (`src/components/LoginGate.tsx`, `showUpgrade`) is now reachable only via the dormant guest paywall. |
| 1 | Auth + guest-gate feature shipped without tests | PARTIAL 2026-06-24 | The Google sign-in (`src/auth.ts`, `/api/auth/[...nextauth]`), the server-enforced 10k-token guest gate (`src/app/api/chat/route.ts`, `src/lib/gate.config.ts`, `tokensUsedByUser()` in `src/lib/db.ts`), and the responsive mobile sidebar/artifact panel were built feature-first, in violation of the now-mandatory test-first rule (`CLAUDE.md` §7.4). **Vitest is now stood up** (the rate-limit work, 2026-06-24, added it) — so the runner blocker is gone. **Retrofit still owed:** unit-test `tokensUsedByUser()` + `gate.config`; integration-test `/api/chat` (gate fires at limit, signed-in unlimited, cookie issuance, fail-closed when `auth()` throws); add Playwright + e2e the mobile drawer + gate modal. Then update `docs/PRD.md` and produce the UAT package. |

---

## Closing #5 (`inSource=false`) — next-session plan (drafted 2026-07-20, to do 2026-07-21)

The common case is fixed (`reconcileAssetMarkers`). What remains is a SEARCH that
also spans the injected `<head>` — marker-strip alone can't match it because the
stored source has an importmap / `AR_ASSETS` script the model never wrote. Its
log signature is `inSource=false afterMarkerStrip=false` **and the SEARCH
contains `<head`**. Today an `afterMarkerStrip=false` line is ambiguous
(head-spanning vs. a genuinely different version), so closing it is a 3-step loop:

**Step 0 (do FIRST, from dev) — make each miss self-classifying.** Strengthen the
`logSearchMiss` line in `src/app/api/chat/route.ts` so a SINGLE prod occurrence
is conclusive, no raw-source eyeballing:
  - add `searchSpansHead` — does `firstSearch` contain `<head` (or `type="importmap"` / `AR_ASSETS`)?
  - add `reconcileBailed=<reason>` — when `reconcileAssetMarkers` returned null, WHY (`not-injected` | `new-asset` | `no-marker`).
  ~10 lines, pure, add a unit test. Folds into the same A change.

**Step 1 — deploy, then collect from EC2** (`ec2-3-110-44-237` alias; logger tees
to `logs/app.log`). A few days of real 3D-game edit turns:
```bash
grep "first SEARCH head" logs/app.log | grep "inSource=false" \
  | grep -oE 'afterMarkerStrip=[a-z]+ searchSpansHead=[a-z]+' | sort | uniq -c
```

**Step 2 — read the counts, then decide:**
  - `afterMarkerStrip=true` misses (after the fix) → reconciliation *bailed*; look at `reconcileBailed=` and tweak the guard.
  - `afterMarkerStrip=false searchSpansHead=true` → the head-spanning residual. Few → **close #5** (Option 6/D already makes the rare rebuild cheap + non-regressive). Common → build the structural fix below.
  - `afterMarkerStrip=false searchSpansHead=false` → a genuinely different version; separate investigation (revisit the history hypothesis).

**Step 3 — structural fix, ONLY if the head-spanning case is common:** patch
against the PRE-injection source and re-inject after — store the raw HTML beside
the deliverable, OR make `injectAssets` idempotent so markers can be retained.
Bigger change (touches the store/serve round-trip), which is why we measure first.

**Resume trigger:** say _"pick up the inSource=false closeout"_ (or _"KNOWN_BUGS
#5 closeout"_) and I'll start at Step 0.
