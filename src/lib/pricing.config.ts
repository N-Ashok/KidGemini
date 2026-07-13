// Per-model token pricing used to estimate cost in the admin dashboard.
// Values are USD per 1M tokens — UPDATE these to match current Gemini pricing
// before relying on cost numbers. Open/Closed: add models without touching call sites.

export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

export const MODEL_PRICING: Record<string, ModelPrice> = {
  // Real published rates (verified 2026-07-13; USD per 1M tokens).
  // BUG-FIX-LOG 2026-07-13: the primary model was MISSING here, so the whole
  // dashboard reported $0. Every model in the fallback chain must be listed.
  // 3.5 Flash is 5x input / 3.6x output vs 2.5 Flash — the cost driver behind
  // the ₹530/day peaks after the 07-11 primary switch. Cached input on 3.5 is
  // $0.15/M — the repeated system prompt should ride implicit caching.
  "gemini-3.5-flash": { inputPerMTok: 1.5, outputPerMTok: 9.0 },
  "gemini-3-flash-preview": { inputPerMTok: 0.5, outputPerMTok: 3.0 },
  "gemini-2.5-flash": { inputPerMTok: 0.3, outputPerMTok: 2.5 },
  "gemini-2.5-flash-lite": { inputPerMTok: 0.1, outputPerMTok: 0.4 },
};

/** Unknown models estimate at the TOP flash-tier rate instead of $0 — an
 *  over-estimate surfaces in the dashboard and gets corrected; a silent $0
 *  hides real spend (that is exactly what happened). */
const FALLBACK_PRICE: ModelPrice = { inputPerMTok: 1.5, outputPerMTok: 9.0 };

export function estimateCostUsd(
  model: string,
  promptTokens: number,
  outputTokens: number,
): number {
  const price = MODEL_PRICING[model] ?? FALLBACK_PRICE;
  return (
    (promptTokens / 1_000_000) * price.inputPerMTok +
    (outputTokens / 1_000_000) * price.outputPerMTok
  );
}
