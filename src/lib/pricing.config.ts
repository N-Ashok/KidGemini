// Per-model token pricing used to estimate cost in the admin dashboard.
// Values are USD per 1M tokens. Prices themselves live in MODEL_CATALOG
// (model-registry.ts) so routing and billing can never disagree about what a
// model costs; this module owns the cost ARITHMETIC and the ₹ conversion.
// Open/Closed: add models to the catalog without touching call sites.

import { MODEL_CATALOG } from "./model-registry";

export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Cached-input rate. Cached tokens are a SUBSET of the prompt count and
   *  bill cheaper; unset falls back to 25% of input (Gemini's typical ratio). */
  cachedInputPerMTok?: number;
}

/**
 * DERIVED from MODEL_CATALOG (cross-provider refactor 2026-07-20) — one price
 * source, not two.
 *
 * Previously this was a hand-maintained Gemini-only table, which meant any
 * non-Gemini model resolved to FALLBACK_PRICE below and billed on the
 * dashboard at $1.5/$9 no matter what it actually cost. That is the same class
 * of bug as BUG-FIX-LOG 2026-07-13 ("the primary model was MISSING here, so
 * the whole dashboard reported $0") — a silent, wrong number is worse than a
 * loud missing one. Adding a model to the catalog now prices it everywhere.
 *
 * Rates: Gemini verified 2026-07-13 against ai.google.dev/gemini-api/docs/pricing
 * (cached-input rates 2026-07-14; thinking tokens bill as output). OpenAI from
 * developers.openai.com/api/docs/pricing, 2026-07-20.
 */
export const MODEL_PRICING: Record<string, ModelPrice> = Object.fromEntries(
  MODEL_CATALOG.map((m) => [
    m.id,
    {
      inputPerMTok: m.inputPerMTok,
      outputPerMTok: m.outputPerMTok,
      ...(m.cachedInputPerMTok !== undefined ? { cachedInputPerMTok: m.cachedInputPerMTok } : {}),
    },
  ]),
);

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
