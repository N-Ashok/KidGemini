// Per-model token pricing used to estimate cost in the admin dashboard.
// Values are USD per 1M tokens — UPDATE these to match current Gemini pricing
// before relying on cost numbers. Open/Closed: add models without touching call sites.

export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Cached-input rate. Cached tokens are a SUBSET of the prompt count and
   *  bill cheaper; unset falls back to 25% of input (Gemini's typical ratio). */
  cachedInputPerMTok?: number;
}

export const MODEL_PRICING: Record<string, ModelPrice> = {
  // Real published rates (verified 2026-07-13; USD per 1M tokens).
  // BUG-FIX-LOG 2026-07-13: the primary model was MISSING here, so the whole
  // dashboard reported $0. Every model in the fallback chain must be listed.
  // 3.5 Flash is 5x input / 3.6x output vs 2.5 Flash — the cost driver behind
  // the ₹530/day peaks after the 07-11 primary switch. Cached input on 3.5 is
  // $0.15/M — the repeated system prompt should ride implicit caching.
  // Cached-input rates from ai.google.dev/gemini-api/docs/pricing (2026-07-14);
  // thinking tokens bill as output on all of these (same source).
  "gemini-3.5-flash": { inputPerMTok: 1.5, outputPerMTok: 9.0, cachedInputPerMTok: 0.15 },
  "gemini-3-flash-preview": { inputPerMTok: 0.5, outputPerMTok: 3.0, cachedInputPerMTok: 0.05 },
  "gemini-2.5-flash": { inputPerMTok: 0.3, outputPerMTok: 2.5, cachedInputPerMTok: 0.03 },
  "gemini-2.5-flash-lite": { inputPerMTok: 0.1, outputPerMTok: 0.4, cachedInputPerMTok: 0.01 },
};

/** Unknown models estimate at the TOP flash-tier rate instead of $0 — an
 *  over-estimate surfaces in the dashboard and gets corrected; a silent $0
 *  hides real spend (that is exactly what happened). */
const FALLBACK_PRICE: ModelPrice = { inputPerMTok: 1.5, outputPerMTok: 9.0 };

/** The 4 billed token types. `prompt` INCLUDES `cached` (Gemini reports
 *  cachedContentTokenCount as a subset of promptTokenCount); `thoughts`
 *  (thinking tokens) bill at the output rate. */
export interface CostTokens {
  prompt: number;
  output: number;
  thoughts?: number;
  cached?: number;
}

export function estimateCostUsd(model: string, tokens: CostTokens): number {
  const price = MODEL_PRICING[model] ?? FALLBACK_PRICE;
  const cached = Math.min(tokens.cached ?? 0, tokens.prompt); // clamp: never negative input
  const cachedRate = price.cachedInputPerMTok ?? price.inputPerMTok * 0.25;
  return (
    ((tokens.prompt - cached) / 1_000_000) * price.inputPerMTok +
    (cached / 1_000_000) * cachedRate +
    (((tokens.output ?? 0) + (tokens.thoughts ?? 0)) / 1_000_000) * price.outputPerMTok
  );
}

/** USD→INR rate for the dashboard's ₹ figures. Not a live FX feed — set
 *  USD_INR_RATE in the env and refresh it when the rate moves; the default
 *  below is only a sane starting point. Stored costs stay in USD (source of
 *  truth); ₹ is derived at read time so a rate update re-prices history. */
const DEFAULT_INR_PER_USD = 95; // owner decision 2026-07-14

export function inrPerUsd(): number {
  const rate = Number(process.env.USD_INR_RATE);
  return Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_INR_PER_USD;
}
