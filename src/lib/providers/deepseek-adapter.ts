// DeepSeek provider adapter — identity + error classification. DeepSeek is
// OpenAI-API-compatible, so its errors carry the same status codes and shapes;
// the taxonomy is identical and delegated to the OpenAI adapter rather than
// duplicated (same arrangement as Moonshot, owner ask 2026-08-12).
//
// Only identity differs: a different key (DEEPSEEK_API_KEY) and provider id.
// Prompt-only + China-based data-handling gate live in the registry.

import type { ProviderAdapter } from "@/types/model-provider.types";
import { openaiAdapter } from "./openai-adapter";

export const deepseekAdapter: ProviderAdapter = {
  provider: "deepseek",

  isConfigured(env) {
    return !!env.DEEPSEEK_API_KEY;
  },

  // OpenAI-compatible error shapes → reuse the exact same walk/throw decisions.
  isModelGone: (err) => openaiAdapter.isModelGone(err),
  shouldTryNextModel: (err) => openaiAdapter.shouldTryNextModel(err),
};
