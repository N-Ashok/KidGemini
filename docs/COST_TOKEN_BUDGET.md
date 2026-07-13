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
| Model catalog (retrieval-lite subset of the library) | ~150–290 | input | `prompt-catalog.ts` |
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
4. **Prefix caching likely never hits** (est. ₹20–30/day) — OPEN. The
   builder system prompt varies per message (retrieval-lite re-picks
   models), breaking Gemini implicit caching on the otherwise append-only
   request prefix (the repeated game code would ride the ~70–90% cached-input
   discount). Fix: stabilize the builder system prompt per conversation.
   **Measure first** — see next section.
5. **Sticky builder mode** (~₹0.3/turn) — ACCEPTED. After any game exists,
   every turn pays the (capped) thinking budget; deliberate, because
   iteration asks don't say "game".
6. **Full-game regeneration on small tweaks** (50–70% of iteration output) —
   PARKED. Patch-mode iteration (like the repair flow's minimal-patch
   contract) is the biggest remaining lever but risks broken games from
   misapplied patches. Revisit at real customer volume.

## Next instrumentation step (before any further optimization)

Record Gemini's exact `usageMetadata` (prompt / output / thinking /
`cachedContentTokenCount`) into `usage_events` instead of the chars÷4
estimate, including failed attempts (kind `chat-failed`). One day of data
answers: is caching hitting (decides #4)? what do failures really cost?
Dashboard then matches the invoice by construction.

## Monitoring runbook

- **Dashboard:** `kidgemini.ariantra.com/admin` (needs `ADMIN_SECRET` from
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
