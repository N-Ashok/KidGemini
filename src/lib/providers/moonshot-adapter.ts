// Moonshot (Kimi) provider adapter — identity + error classification. Moonshot
// is OpenAI-API-compatible, so its errors carry the same status codes and
// shapes; the taxonomy is identical and delegated to the OpenAI adapter rather
// than duplicated (owner decision 2026-07-20, "extend to … Kimi").
//
// Only identity differs: a different key (MOONSHOT_API_KEY) and provider id.
// Prompt-only + China-based data-handling gate live in the registry.

import type { ProviderAdapter } from "@/types/model-provider.types";
import { openaiAdapter } from "./openai-adapter";

export const moonshotAdapter: ProviderAdapter = {
  provider: "moonshot",

  isConfigured(env) {
    return !!env.MOONSHOT_API_KEY;
  },

  // OpenAI-compatible error shapes → reuse the exact same walk/throw decisions.
  isModelGone: (err) => openaiAdapter.isModelGone(err),
  shouldTryNextModel: (err) => openaiAdapter.shouldTryNextModel(err),
};
