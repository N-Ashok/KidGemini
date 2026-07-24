# Gemini Cost & Token Budget

Where every token goes, what it costs, what was wasted and fixed, and how to
monitor it. Born from the 2026-07-13 billing investigation (₹2.1K/28 days,
₹530 peak days). Owner decisions of that date throughout. Companion docs:
`BUG-FIX-LOG.md` (2026-07-13 entries), `PRD-MODEL-FALLBACK.md`, platform
`ECOSYSTEM.md`.

## The July 2026 investigation — what the bill was made of

A ₹530 peak day decomposed into three multiplied factors:

| Factor | Share | Status |
|---|---|---|
| Base product cost (~65 delivered games/day) | ~₹130 | legitimate — the product working |
| Premium model (3.5 Flash at $1.5/$9 per MTok, 3.6× the 2.5 rate) | ~3.5× | **fixed** — 3-flash-preview primary (2026-07-13) |
| Failure tax (503 storms → billed attempts that delivered nothing, ~40% of requests) | ~1.4× | **fixed** — resume/hedge/restart (2026-07-13) |

Made invisible by two metering bugs (both fixed 2026-07-13): output metering
excluded the game code (~75× undercount), and unlisted models priced at $0.

**Expected steady state after fixes: ~₹1.5–3 per delivered game;
₹140–190/day at ~65 games/day.** A clean day materially above that =
investigate (see Monitoring).

## Token flow — one game-build turn

| Component | Tokens | Billed as | Notes |
|---|---|---|---|
| Child-safety system prompt | ~1,100 | input, every turn | stable, necessary |
| 3D engine section (keyword/artifact-gated) | ~450 | input, 3D turns | `catalog-gate.ts` |
| Model catalog (**the whole library**, 106 models) | ~889 | input | `prompt-catalog.ts` — static since 2026-07-24 (was a varying 150–290; see waste ledger #4). Grows with the library; ceiling 1,500 pinned by test |
| Audio catalog (keyword-gated) | ~150 | input | |
| Newest game's code in history | ~10–15k | input, every iteration turn | older versions stripped to placeholders (`history-trim.ts`, 12-msg window) |
| Kid's message (+ folded text attachment) | 10–100+ | input | |
| Image attachment | ~258 flat | input | |
| Thinking | ≤1,024 (capped) | output | `GEMINI_BUILDER_THINKING_BUDGET` |
| The generated game | ~10–20k | output | **the dominant cost** |

Plain chat turns: system prompt + window only; thinking 0; no catalogs.
Repair calls (self-healing preview): ~4–8k input, ≤4k output, rare — watch
via TECH_DEBT #30.

## Model chain & pricing (verified 2026-07-13; `pricing.config.ts` mirrors this)

| Model | In/Out per MTok | Role |
|---|---|---|
| gemini-3-flash-preview | $0.50 / $3.00 | **primary** — Gemini-3-class game code at near-2.5 prices |
| gemini-2.5-flash | $0.30 / $2.50 | fallback 1 (cheap rescue) |
| gemini-3.5-flash | $1.50 / $9.00 | fallback 2 (premium, emergencies only) |
| gemini-2.5-flash-lite | $0.10 / $0.40 | last resort |

Defaults hardcoded in `gemini.ts` / `model-fallback.ts`; the box `.env`
(`GEMINI_CHAT_MODEL`, `GEMINI_FALLBACK_MODELS`) **overrides** them — keep
both in sync or delete the env vars. Any model added to the chain MUST be
added to `MODEL_PRICING` (pinned by `pricing.config.test.ts`; unknown models
now over-estimate at the top flash rate, never $0).

## Waste ledger — found, ranked, status

1. **Failure re-billing** (~35% of peak-day spend) — ✅ fixed: resumable
   turns (`turn_results` + `/api/chat/result`), mid-answer restart, hedge
   race. A died stream no longer means a paid re-generation.
2. **Premium model on every turn** — ✅ fixed: cost-aware chain above.
3. **Invisible metering** — ✅ fixed: full-reply output metering (route
   M.1 test) + real prices + no-$0-for-unknown-models.
4. **Prefix caching never hits** — **MEASURED 2026-07-24: 3.7%.** Fix shipped,
   effect not yet re-measured.

   Baseline (local dev DB, trailing 14 days, `usage_events`):

   | rows | billedPromptTokens | cachedTokens | cached % |
   |---|---|---|---|
   | 225 | 1,135,094 | 42,482 | **3.7%** |

   The suspicion was right: caching is effectively absent. The builder system
   prompt varied per message (retrieval-lite re-picked models per turn),
   breaking Gemini implicit caching on the otherwise append-only request
   prefix — including the ~10–15k tokens of repeated game code behind it,
   which would otherwise ride the ~70–90% cached-input discount.

   **Fix shipped 2026-07-24:** the build-turn model catalog is now static and
   conversation-stable (`prompt-catalog.ts`; PRD-3D-GAMES-AND-ASSETS §14
   Amendment 3). The whole builder system prompt is now byte-identical across
   messages — pinned by a test, so it cannot silently regress. Costs ~889
   catalog tokens instead of a varying 150–290, which is the trade being made.

   **Caveats — do not over-read this number:**
   - It is the **local dev** DB (225 turns/14d), not production. The rate is
     suggestive; the number that matters is on EC2
     (`/var/lib/kidgemini/kidgemini.db`). The old ₹20–30/day estimate is
     unverified and was NOT confirmed by this measurement.
   - Dev testing opens many short, fresh conversations, which cache poorly
     regardless of prompt stability. So 3.7% is **consistent with** the
     prompt-variance hypothesis without isolating it as the sole cause.
   - The baseline is historical: rows written after 2026-07-24 reflect the new
     behaviour. Compare pre/post by `createdAt`.

   **Re-measure** on prod with the same query, split by `createdAt` either side
   of the deploy. If the rate does not move materially, the remaining suspect
   is conversation-shape (short sessions), not the system prompt — and the
   catalog's ~600 extra tokens should then be reconsidered against the
   category-map hybrid fallback.
5. **Sticky builder mode** (~₹0.3/turn) — ACCEPTED. After any game exists,
   every turn pays the (capped) thinking budget; deliberate, because
   iteration asks don't say "game".
6. **Full-game regeneration on small tweaks** (50–70% of iteration output) —
   PARKED. Patch-mode iteration (like the repair flow's minimal-patch
   contract) is the biggest remaining lever but risks broken games from
   misapplied patches. Revisit at real customer volume.
7. **Losing calls from a fan-out went unbilled** — ✅ fixed 2026-07-21 (owner
   ask). The one-shot chain (`runOneShotChain`, used by patch-regen / strict
   edit retry / repair) keeps earlier attempts ALIVE as it adds backups, so a
   single request can fire several billable calls while only the winner was
   recorded. A losing backup that finishes after the winner is now captured
   (`onLoserResult` → real billed usage) and recorded as **`kind:"fallback"`**:
   COUNTED in the dashboard cost total, but EXEMPT from the child's quota (our
   race waste, not their request — same treatment as `repair`). Per-request
   call visibility lives in `logs/model-decisions.jsonl` (PRD-MODEL-FALLBACK §4).
   STILL OPEN (smaller): the STREAMING hedge loser is cancelled mid-race
   (`it.return()`), so it never delivers a usage count — its output is ≈0
   (it lost by not answering first), leaving only an unbilled input cost. See
   the note below.

## Next instrumentation step (before any further optimization)

✅ SHIPPED 2026-07-14 (partially): Gemini's exact `usageMetadata` (prompt /
output / thinking / `cachedContentTokenCount`) now lands in `usage_events`
as `billedPromptTokens` / `billedOutputTokens` / `thoughtTokens` /
`cachedTokens`. The old `promptTokens`/`outputTokens` columns stay chars÷4
estimates ON PURPOSE — the guest/daily gates are tuned to them; switching
them to real counts (which include the big system prompt) would silently
slash the guest trial severalfold. Cost is now priced from the 4 real types
(cached at the cached-input rate, thinking at the output rate). The admin
dashboard adds today/week/month/year/all-time rollups (IST calendar) and ₹
(via `USD_INR_RATE`). Rows before 2026-07-14 have billed=estimate backfill.
STILL OPEN: attempts that die/lose on the STREAMING path are not billed — a
stream that dies before `usageMetadata`, or a hedge loser cancelled mid-race,
still costs (mostly input) money we don't meter. The one-shot fan-out losers
ARE now billed (`kind:"fallback"`, 2026-07-21 — see Waste ledger #7); the
streaming remainder is the last open metering gap and is small (hedge is rare;
loser output ≈0). Fix if it ever matters: estimate the loser's input cost from
the turn's prompt at the loser model's rate (the ledger already lists every
`abandoned` loser in `logs/model-decisions.jsonl`).

## Monitoring runbook

- **Dashboard:** `games-lab.ariantra.com/admin` (needs `ADMIN_SECRET` from
  the box `.env`) — totals, per-day with top spender, per-user, per-location,
  per-call detail. Rows before 2026-07-13 are undercounted (metering bugs) —
  use Google billing for history.
- **Ground truth:** AI Studio usage charts + billing console (group by SKU;
  costs lag up to 24h).
- **Failure tax spot-check** (on the box; healthy = 3rd number small):
  `grep "$(date -u +%Y-%m-%d)" ~/kidgemini/logs/app.log | grep -c "▶ start"` ·
  same for `"✓ shown"` · same for `-cE "✖ stream error|falling back|died mid"`.
- **Live model check:** `grep "chatModel=" ~/kidgemini/logs/app.log | tail -3`.
- **Ad-hoc DB queries:** the prod DB is `~/kidgemini/data/kidgemini.db`
  (NOT /var/lib); use single-line `node -e` with
  `require("/home/ubuntu/kidgemini/node_modules/better-sqlite3")`; SQLite
  there rejects double-quoted string literals — bind parameters instead.

## Triggers for revisiting

- A clean (low-failure) day above ~₹200 at family-only usage.
- Before any marketing push (volume multiplies everything here).
- Google repricing or retiring `gemini-3-flash-preview` (chain absorbs the
  404, but the cost profile changes — re-run the model comparison).
- Paid tier launch: ₹/game from this doc is the unit-economics floor.
