# PRD — Browser e2e testing (layout smoke now, flow harness later)

**Status:** proposed 2026-07-24 · **Owner decisions:** pending
**Scope:** Ari (`Game`) repo. Two tiers, sequenced — Tier 1 (layout smoke)
recommended to build now; Tier 2 (flow harness) documented for a later,
explicit go-ahead.
**Code (to add):** `e2e/` (specs) · `playwright.config.ts` · `package.json`
(`test:e2e` script + `@playwright/test` devDependency)
**Related:** `docs/PRD-SELF-HEALING-PREVIEW.md` (the in-product game verifier —
NOT replaced by this), `../Ariantra-Platform/docs/TECH_DEBT.md` #64(b)

---

## 1. The problem

We have 1,282 passing unit/integration tests and zero browser tests. That leaves
one whole class unguarded: **rendered-geometry and real-DOM facts** — anything
true only once a real browser lays the page out.

Concretely, on 2026-07-24 a throwaway Playwright run (Playwright not even in the
repo) found a **5px horizontal overflow at 375px on every page** — the shared
Ariantra nav's account icon spilling past the viewport. Not one of the 1,282
tests could see it, because none render pixels. That is exactly the mobile-first
guarantee in CLAUDE.md §6, and it was silently broken.

Two secondary problems:

- **CLAUDE.md §7.4 and §8 instruct `npm run test:e2e`, which does not exist.**
  The gate asserts a check that never runs (see TECH_DEBT — file alongside this).
- The self-healing preview's probe scenarios (`preview-verify.test.ts`, 20+
  rows) run in `node:vm` against a **hand-built fake DOM**. Classification is
  well covered, but nothing exercises the real injection + `postMessage`
  handshake in an actual iframe — if that broke, every game would silently lose
  self-healing with all tests green.

## 2. What this is NOT

**This does not test generated games.** The browser already tests every built
game, on the child's real device, every turn: `src/lib/preview-verify.ts`
injects a probe into the sandboxed iframe that wraps `requestAnimationFrame`,
checks the canvas bitmap, samples a downsampled pixel hash to tell "drawing"
from "static/black", ghost-clicks Start, and reports evidence back for
classification. That is superior to CI e2e for that purpose — real hardware,
every game, wired into the repair loop. **This PRD must not duplicate it.**

It also does **not** close TECH_DEBT #64(b) ("structurally-complete game renders
nothing"). That gap is *pre-delivery, server-side, per-turn, on the 1 GB EC2
box*. A dev-machine harness cannot help — the constraint is where a browser runs
in production, not whether one exists in CI.

## 3. Non-goals

- No visual-regression / screenshot-diffing (flaky, high-maintenance; revisit
  only if a pixel-perfect brand contract emerges).
- No testing of the cross-app SSO round-trip to the platform (:3000) — that is
  the platform repo's e2e surface.
- No hitting the live Gemini API from a test, ever (nondeterministic + real
  money). Chat turns, when tested at all (Tier 2), use a stubbed `/api/chat`.
- No replacement of any unit/integration test. e2e covers only what a real
  browser reveals that jsdom/`node:vm` cannot.

---

## 4. Tier 1 — Layout smoke (build now)

**Goal:** pin the class that just bit us — layout overflow and console errors on
real pages at real viewports — with the smallest possible harness and zero
fixtures.

### 4.1 Coverage matrix

| Route | Why it's in | Desktop 1280 | Mobile 375 |
|---|---|---|---|
| `/` | kid home, the busiest surface | ✓ | ✓ |
| `/bible-teacher` | different nav/persona surface | ✓ | ✓ |
| `/assets` | 159-card gallery — heaviest DOM | ✓ | ✓ |
| `/parent` | PIN wall (unauthenticated view) | ✓ | ✓ |
| `/upgrade` | pricing/marketing copy | ✓ | ✓ |

### 4.2 Assertions per page (all fixture-free)

1. **No horizontal overflow:** `scrollWidth − clientWidth ≤ 0` on
   `documentElement`. On failure, report the narrowest offending element
   (deepest cause, not its ancestors) — the diagnostic that located the nav
   overflow in one run.
2. **No console errors and no uncaught page errors** during load +
   `networkidle`. (Warnings allowed; errors are a fail.)
3. **The mobile tab bar renders its expected tabs** for the surface
   (kid: Chat/Arcade/Toy Box/Parent; bible-teacher: Chat/Arcade/Toy Box, no
   Parent) — a real-DOM cross-check of `nav-tabs.ts`, which unit tests already
   cover as data.
4. **Primary heading present** (`h1`/`h2` non-empty) — a cheap "page actually
   rendered, not a white screen" guard.

### 4.3 Explicitly out of Tier 1

Anything needing auth, a session, a seeded DB, or a model call. If a page's
*unauthenticated* state can't be asserted meaningfully (none of the five above
have that problem), it waits for Tier 2.

### 4.4 Cost & shape

- ~50–80 lines of spec + a ~20-line `playwright.config.ts` (starts `next dev`
  via `webServer`, one chromium project, two viewport projects).
- `@playwright/test` as a devDependency; browsers already cached on dev machines
  (`~/Library/Caches/ms-playwright`), so no extra download in the common case.
- New script: `"test:e2e": "playwright test"`. This makes CLAUDE.md §7.4/§8
  honest.
- Runtime: a few seconds. Runs on demand and in CI; **not** part of
  `npm run test` (keeps the unit loop fast).

**Estimated effort: ~1 hour including CI wiring.**

---

## 5. Tier 2 — Flow harness (later, explicit go-ahead only)

**Goal:** exercise real user journeys end-to-end in a browser. Higher value per
flow, but the cost is almost entirely **fixtures**, not Playwright.

### 5.1 Flows, ranked by value ÷ fixture cost

| Flow | What it proves | Fixture needed |
|---|---|---|
| Real 3D artifact renders | the actual `loadModel` + meshopt path paints pixels (the check my throwaway `smoke.mjs` got WRONG by hand-rolling the loader) | none — load a real published model through the real runtime helper |
| Chat → build → preview | a prompt yields a game that boots in the iframe | **stubbed `/api/chat`** returning a canned game doc |
| Publish to arcade | name check → publish flow → success | stubbed publish route + a fake session |
| Parent PIN gate | set PIN → verify → dashboard | **seeded test DB** (the real one is off-limits) + session |
| Idea queue | type-while-busy queues, sends in order | stubbed chat + localStorage assertions |

### 5.2 The real work is fixtures, not specs

- **Stubbed `/api/chat`:** a Playwright route intercept (or a `TEST_MODE` env
  flag on the route) returning a deterministic game document — no Gemini, no
  spend, no flakiness. This is the keystone; most flows depend on it.
- **Test session:** a way to mint an authenticated cookie without the SSO round
  trip (a dev-only signed token, gated behind an env flag, never in prod).
- **Test database:** an ephemeral SQLite seeded per run (`DATABASE_PATH` to a
  temp file), NEVER the real `data/` DB (Hard rule). The schema already builds
  itself from `db.ts`, so seeding is inserts, not migrations.

### 5.3 Filling the `preview-verify` gap (optional sub-item)

One Tier-2-adjacent spec worth calling out: load a known-healthy and a
known-black game document into a real iframe and assert the probe pipeline
classifies each correctly end-to-end. This is the ONE thing that exercises the
real injection + `postMessage` handshake the `node:vm` tests fake. Small, and it
closes the "self-healing silently breaks, tests stay green" risk from §1. Could
even ride in Tier 1 if the harness is already up, since it needs no auth/DB.

### 5.4 Cost

**Estimated effort: several days, majority in fixtures**, plus ongoing upkeep as
routes and auth evolve. Justified only when flow coverage is a stated priority —
today the unit/integration suite covers these paths' logic well; only the
*rendered* assembly is unproven.

---

## 6. Decisions needed

1. **Build Tier 1 now?** (Recommendation: yes — ~1h, catches a live bug class,
   makes the CLAUDE.md gate honest.)
2. **Include the §5.3 probe-handshake spec in Tier 1?** (Recommendation: yes if
   the harness is up — no fixtures, real risk retired.)
3. **Commit to Tier 2, and if so which flows first?** (Recommendation: defer;
   pick up only when a flow's *assembly* — not its logic — starts breaking.)
4. **CI wiring:** run Tier 1 on every PR, or nightly? (Recommendation: per-PR;
   it's seconds and layout regressions should block merge.)

## 7. Success criteria

- Tier 1: `npm run test:e2e` exists and passes; a re-introduced horizontal
  overflow at 375px fails it; CLAUDE.md §7.4/§8 no longer reference a
  non-existent command.
- The nav-overflow bug (once fixed in the platform brand CSS) has a Tier-1
  regression assertion so it cannot silently return.

## 8. Scale ceilings & maintenance

- Layout smoke is O(routes × viewports); adding a public route adds one matrix
  row. Fine to hundreds of routes.
- Tier 2 upkeep scales with auth/route churn — the argument for keeping fixtures
  minimal and deferring flows until they earn their place.
- Browsers are cached per dev machine; CI needs a `playwright install chromium`
  step (~1 browser, chromium-only, to keep CI lean).
