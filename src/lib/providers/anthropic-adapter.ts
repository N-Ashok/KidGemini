// Anthropic (Claude) provider adapter — identity + error classification only
// (owner decision 2026-07-20, "extend to Claude and Kimi"). Same split as the
// OpenAI adapter: this pure taxonomy is pinned by tests with no network or SDK
// surface; generation lives in anthropic-generation.ts.
//
// Claude is a `prompt-only` model in the registry (no per-request safety
// threshold knob, and we chose not to front it with a moderation pass) — so it
// only reaches a chain when ALLOW_PROMPT_ONLY_SAFETY_MODELS=1 AND ANTHROPIC_API_KEY
// are both set. This file just decides which failures walk the chain.

import type { ProviderAdapter } from "@/types/model-provider.types";

/** Fields anthropic-generation.ts attaches to a thrown error (from the HTTP
 *  response) so this classifier can read them without any SDK type. */
interface MaybeApiError {
  status?: number;
  /** Anthropic error `type`, e.g. "overloaded_error", "rate_limit_error". */
  errorType?: string;
  message?: string;
}

const read = (err: unknown): MaybeApiError => (err && typeof err === "object" ? (err as MaybeApiError) : {});
const msg = (err: unknown): string => String(read(err).message ?? "");

/** 429 rate limit — a different model is a different bucket, so walk. */
function isRateLimited(err: unknown): boolean {
  const e = read(err);
  return e.status === 429 || e.errorType === "rate_limit_error" || /\b429\b|rate.?limit/i.test(msg(err));
}

/** Anthropic's dedicated "we're overloaded" — status 529 (walk). */
function isOverloaded(err: unknown): boolean {
  const e = read(err);
  return e.status === 529 || e.errorType === "overloaded_error" || /\b529\b|overloaded/i.test(msg(err));
}

/** Model id retired or mistyped — skip down AND scream (prod misconfigured). */
export function isModelGone(err: unknown): boolean {
  const e = read(err);
  return (e.status === 404 || e.errorType === "not_found_error") || /\b404\b|not_found|model:.*not found/i.test(msg(err));
}

/** Transient server/network failure (walk). */
function isTransient(err: unknown): boolean {
  const e = read(err);
  if (e.status && [500, 502, 503, 504].includes(e.status)) return true;
  if (e.errorType === "api_error") return true;
  return /\b(500|502|503|504)\b|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|socket hang up|\bterminated\b/i.test(
    msg(err),
  );
}

/** A safety refusal expressed as an error (rare — Claude usually declines
 *  in-content, which the runner catches via finishReason). A block is a verdict,
 *  never an outage: fail closed rather than shop another model for a yes. */
function isContentFiltered(err: unknown): boolean {
  const e = read(err);
  return e.errorType === "permission_error" && /content|safety|policy/i.test(msg(err));
}

export const anthropicAdapter: ProviderAdapter = {
  provider: "anthropic",

  isConfigured(env) {
    return !!env.ANTHROPIC_API_KEY;
  },

  isModelGone,

  /**
   * Capacity (429/529), retired ids and transient infra move DOWN the chain;
   * a content refusal, auth (401/403) and 400s throw. Unknown failures return
   * false by design — a real defect retried across models becomes a slow
   * timeout instead of an honest error.
   */
  shouldTryNextModel(err) {
    if (isContentFiltered(err)) return false;
    return isRateLimited(err) || isOverloaded(err) || isModelGone(err) || isTransient(err);
  },
};
