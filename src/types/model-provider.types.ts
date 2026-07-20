// Cross-provider model abstraction (owner decision 2026-07-20: reverses
// PRD-MODEL-FALLBACK §7's "cross-provider fallback is a non-goal").
//
// The old chain was a list of model-ID STRINGS walked against one GoogleGenAI
// client — adding "gpt-…" to it produced a 404 that isModelGone() silently
// skipped, so it looked configured and did nothing. Everything a caller needs
// to route a turn now travels WITH the model, not in gemini.ts.

/** Who serves the model. Adding one = adding an adapter, not editing callers. */
export type ProviderId = "google" | "openai" | "anthropic" | "moonshot";

/**
 * Capability class. Models in the SAME tier are treated as interchangeable for
 * a turn, which is precisely what lets the chain sort purely by price (owner
 * decision 2026-07-20: "when they are all same, based on price"). Tier is a
 * judgement call about output quality, NOT a price bucket — putting a weaker
 * model in a richer tier silently degrades games, so tier changes want a real
 * side-by-side on game-build turns, not a pricing-page reading.
 */
export type CapabilityTier =
  /** Best code quality — game BUILD turns. */
  | "frontier"
  /** Solid general model — chat turns, edits, most work. */
  | "workhorse"
  /** Fast + cheapest — repairs, classifiers, last-resort rescue. */
  | "lite";

/**
 * How child-safety is enforced for this model — the reason this file exists
 * rather than a plain price list.
 *
 * Ari's documented posture (CLAUDE.md §3) is three layers: deterministic input
 * rules → **provider-enforced safety thresholds** → child-safety system
 * prompt. The middle layer is Gemini's native `safetySettings`
 * (HarmCategory/HarmBlockThreshold, gemini.ts GEN_CONFIG). A provider without
 * an equivalent knob keeps only layers 1 and 3 — a REAL reduction in the
 * safety floor of a product for 7–14 year olds, not a technicality.
 *
 * So every model must declare this, and `prompt-only` models are excluded from
 * every chain unless explicitly opted into (see model-registry.ts). Fail
 * closed: a new adapter that forgets to think about safety is unusable by
 * default rather than quietly weaker.
 */
export type SafetyPosture =
  /** Provider enforces category thresholds server-side (Gemini safetySettings). */
  | "provider-enforced"
  /** Only our system prompt + input rules stand between the kid and the model. */
  | "prompt-only";

/** One routable model. Price is USD per 1M tokens, same units as pricing.config.ts. */
export interface ModelSpec {
  /** EXACT API model id string passed to that provider's SDK. */
  id: string;
  provider: ProviderId;
  tier: CapabilityTier;
  inputPerMTok: number;
  outputPerMTok: number;
  /** Cached-input rate; unset falls back to 25% of input (pricing.config.ts). */
  cachedInputPerMTok?: number;
  safety: SafetyPosture;
}

/**
 * What every provider adapter implements. Deliberately NARROW: the chain walks
 * these, so anything Gemini-specific (safetySettings, thinkingConfig,
 * inlineData shapes) belongs inside an adapter, never in the chain.
 *
 * Error classification is per-provider on purpose — "overloaded" is a 503 on
 * Google and a 429 `insufficient_quota` vs `rate_limit_exceeded` distinction on
 * OpenAI, and getting that wrong either masks a real defect (billing failure
 * retried forever) or dead-ends a recoverable outage.
 */
export interface ProviderAdapter {
  readonly provider: ProviderId;
  /** False when the key is absent — the registry drops the provider's models
   *  rather than discovering it mid-incident on the failover attempt. */
  isConfigured(env: Record<string, string | undefined>): boolean;
  /** Capacity/transient/retired → walk the chain. Safety, auth, 400s → throw. */
  shouldTryNextModel(err: unknown): boolean;
  /** Retired/unknown model id — logged as CHECK CONFIG, not a generic outage. */
  isModelGone(err: unknown): boolean;
}

/**
 * A turn, expressed WITHOUT any provider's vocabulary. Each adapter translates
 * this into its own request shape — Gemini's contents/parts/inlineData +
 * safetySettings + thinkingConfig, OpenAI's messages/image_url, and so on.
 *
 * Anything that only ONE provider understands (thinking budgets, harm-category
 * thresholds) stays inside that adapter. If a field here starts needing a
 * provider-specific escape hatch, that is the signal the abstraction is wrong,
 * not an invitation to add `geminiConfig?: unknown`.
 */
export interface GenerationRequest {
  /** Prior turns, oldest first. */
  history: Array<{ role: "child" | "assistant"; text: string }>;
  message: string;
  image?: { mimeType: string; data: string };
  /** The full system prompt for this turn (child-safety base + builder mode). */
  systemInstruction: string;
  maxOutputTokens: number;
}

/** Billed token counts, provider-normalized. */
export interface NormalizedUsage {
  promptTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  cachedTokens: number;
}
