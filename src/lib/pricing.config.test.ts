// Regression (BUG-FIX-LOG 2026-07-13): the primary model wasn't in
// MODEL_PRICING, so estimateCostUsd returned 0 and the admin dashboard
// reported $0 while real Gemini billing accrued. Unknown models must now
// fail VISIBLE (conservative fallback estimate), never silently $0.
// 2026-07-14: cost now covers all 4 billed token types (prompt / output /
// thinking / cached) + the USD→INR conversion the admin dashboard renders.
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { estimateCostUsd, inrPerUsd, MODEL_PRICING } from "./pricing.config";
import { MODEL_CATALOG } from "./model-registry";

const OLD_RATE = process.env.USD_INR_RATE;
afterAll(() => {
  if (OLD_RATE === undefined) delete process.env.USD_INR_RATE;
  else process.env.USD_INR_RATE = OLD_RATE;
});
beforeEach(() => {
  delete process.env.USD_INR_RATE;
});

describe("estimateCostUsd", () => {
  it("every model in the production chain has an explicit price", () => {
    // 2026-08-18: primary moved to gemini-3.6-flash, chain 3.7 → 3.5 →
    // 3.1-pro-preview → 3.5-flash-lite (owner decision). The OLD ids stay
    // priced — a box still running the previous GEMINI_CHAT_MODEL must not
    // start billing at the unknown-model fallback rate.
    for (const model of [
      "gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.1-pro-preview", "gemini-3.5-flash-lite",
      "gemini-3.5-flash", "gemini-3-flash-preview", "gemini-2.5-flash", "gemini-2.5-flash-lite",
    ]) {
      expect(MODEL_PRICING[model], `${model} missing from MODEL_PRICING`).toBeDefined();
    }
  });

  it("C.6 the 2026-08-18 Gemini 3.6/3.7 rates are pinned (promo rate, ai.google.dev/gemini-api/docs/pricing)", () => {
    // Both sit on the SAME promotional rate through 2026-12-31, after which
    // Google doubles it to $1.50/$7.50/$0.15. See TECH_DEBT #107 — this
    // assertion is the tripwire that makes the reprice a loud edit, not a
    // silent 2x on a child's Sparks balance.
    for (const id of ["gemini-3.6-flash", "gemini-3.7-flash"]) {
      expect(MODEL_PRICING[id]!.inputPerMTok, id).toBe(0.75);
      expect(MODEL_PRICING[id]!.outputPerMTok, id).toBe(3.75);
      expect(MODEL_PRICING[id]!.cachedInputPerMTok, id).toBe(0.075);
    }
  });

  it("C.7 the model switch must LOWER the per-turn cost, never raise it (owner ask 2026-08-18)", () => {
    // A representative game-BUILD turn. The whole point of moving to 3.6 is
    // that the kid is charged fewer Sparks; Sparks are a pure multiple of this
    // number (platform spark-cost.ts), so pinning it here pins the outcome.
    const TURN = { prompt: 8000, output: 4000, cached: 4000 };
    const now = estimateCostUsd("gemini-3.6-flash", TURN);
    expect(now).toBeLessThan(estimateCostUsd("gemini-3.5-flash", TURN));
    expect(now).toBeCloseTo(0.0183, 6); // vs $0.0426 on 3.5-flash — 57% cheaper
  });

  it("a known model prices by its table entry", () => {
    const usd = estimateCostUsd("gemini-2.5-flash", { prompt: 1_000_000, output: 1_000_000 });
    expect(usd).toBeCloseTo(0.3 + 2.5, 5);
  });

  it("an UNKNOWN model never estimates $0 — conservative fallback instead", () => {
    const usd = estimateCostUsd("gemini-99-ultra", { prompt: 1_000_000, output: 1_000_000 });
    expect(usd).toBeGreaterThan(0);
  });

  it("zero tokens cost zero regardless of model", () => {
    expect(estimateCostUsd("gemini-99-ultra", { prompt: 0, output: 0 })).toBe(0);
  });

  it("C.2 thinking tokens bill at the OUTPUT rate", () => {
    const usd = estimateCostUsd("gemini-2.5-flash", { prompt: 0, output: 0, thoughts: 1_000_000 });
    expect(usd).toBeCloseTo(2.5, 10);
  });

  it("C.3 cached tokens bill at the cached-input rate; the remainder at full input", () => {
    // 1M prompt of which 0.5M cached: 0.5M*$0.30 + 0.5M*$0.03 = 0.15 + 0.015
    // (cached rates per ai.google.dev/gemini-api/docs/pricing, 2026-07-14)
    const usd = estimateCostUsd("gemini-2.5-flash", { prompt: 1_000_000, output: 0, cached: 500_000 });
    expect(usd).toBeCloseTo(0.165, 10);
  });

  it("C.3b published cached rates are pinned (silent drift = wrong invoices)", () => {
    expect(MODEL_PRICING["gemini-3-flash-preview"]!.cachedInputPerMTok).toBe(0.05);
    expect(MODEL_PRICING["gemini-3.5-flash"]!.cachedInputPerMTok).toBe(0.15);
  });

  it("R.0 default rate is ₹95/USD (owner decision 2026-07-14)", () => {
    expect(inrPerUsd()).toBe(95);
  });

  it("C.4 cached > prompt never yields negative cost (clamped)", () => {
    const usd = estimateCostUsd("gemini-2.5-flash", { prompt: 100, output: 0, cached: 1_000_000 });
    expect(usd).toBeGreaterThanOrEqual(0);
  });

  it("C.5 every listed model's cached rate is at or below its input rate", () => {
    for (const [model, p] of Object.entries(MODEL_PRICING)) {
      if (p.cachedInputPerMTok !== undefined) {
        expect(p.cachedInputPerMTok, model).toBeLessThanOrEqual(p.inputPerMTok);
      }
    }
  });
});

describe("inrPerUsd", () => {
  it("R.1 defaults sensibly when USD_INR_RATE is unset", () => {
    expect(inrPerUsd()).toBeGreaterThan(0);
  });

  it("R.2 honors the USD_INR_RATE env override", () => {
    process.env.USD_INR_RATE = "90.5";
    expect(inrPerUsd()).toBe(90.5);
  });

  it("R.3 garbage or non-positive values fall back to the default", () => {
    process.env.USD_INR_RATE = "banana";
    const d = inrPerUsd();
    expect(d).toBeGreaterThan(0);
    process.env.USD_INR_RATE = "-5";
    expect(inrPerUsd()).toBe(d);
  });
});

// Cross-provider refactor 2026-07-20: MODEL_PRICING is now DERIVED from
// MODEL_CATALOG. Before this, any non-Gemini model fell through to
// FALLBACK_PRICE and billed at $1.5/$9 on the dashboard regardless of its real
// cost — silently wrong numbers, the same class as the 2026-07-13 "$0" bug.
describe("MODEL_PRICING is derived from the catalog (one price source)", () => {
  it("P.10 every catalogued model is priced, including non-Gemini providers", () => {
    for (const m of MODEL_CATALOG) {
      expect(MODEL_PRICING[m.id], `${m.id} missing from MODEL_PRICING`).toBeDefined();
      expect(MODEL_PRICING[m.id]!.inputPerMTok).toBe(m.inputPerMTok);
      expect(MODEL_PRICING[m.id]!.outputPerMTok).toBe(m.outputPerMTok);
    }
  });

  it("P.11 an OpenAI model bills at ITS OWN rate, not the Gemini fallback rate", () => {
    const usd = estimateCostUsd("gpt-5.4-nano", { prompt: 1_000_000, output: 1_000_000 });
    expect(usd).toBeCloseTo(0.2 + 1.25, 6); // not 1.5 + 9.0
  });
});
