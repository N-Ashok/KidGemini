// Per-model token pricing used to estimate cost in the admin dashboard.
// Values are USD per 1M tokens — UPDATE these to match current Gemini pricing
// before relying on cost numbers. Open/Closed: add models without touching call sites.

export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

export const MODEL_PRICING: Record<string, ModelPrice> = {
  // Placeholder figures — confirm against current Gemini pricing.
  "gemini-2.5-flash": { inputPerMTok: 0.3, outputPerMTok: 2.5 },
  "gemini-2.5-flash-lite": { inputPerMTok: 0.1, outputPerMTok: 0.4 },
};

export function estimateCostUsd(
  model: string,
  promptTokens: number,
  outputTokens: number,
): number {
  const price = MODEL_PRICING[model];
  if (!price) return 0;
  return (
    (promptTokens / 1_000_000) * price.inputPerMTok +
    (outputTokens / 1_000_000) * price.outputPerMTok
  );
}
