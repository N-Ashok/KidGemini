// OpenAI provider adapter (owner decision 2026-07-20, cross-provider fallback).
//
// Scope of THIS file: identity + error classification — the pure decisions the
// chain runner needs. Generation/streaming and the moderation pass land next;
// they are kept separate so this taxonomy can be pinned by tests without any
// network or SDK surface.
//
// Deliberately NOT a copy of model-fallback.ts's Gemini regexes. OpenAI
// overloads 429 with two opposite meanings, and the difference decides whether
// a kid waits through four doomed models or gets a fast, honest failure.

import type { ProviderAdapter } from "@/types/model-provider.types";

/** Structured fields the OpenAI SDK puts on APIError; absent on raw net errors. */
interface MaybeApiError {
  status?: number;
  code?: string;
  message?: string;
}

const read = (err: unknown): MaybeApiError => (err && typeof err === "object" ? (err as MaybeApiError) : {});

const msg = (err: unknown): string => String(read(err).message ?? "");

/**
 * Billing/quota exhaustion. Shares status 429 with ordinary rate limiting, but
 * it is a DEFECT, not capacity: no sibling model can clear an unpaid account,
 * so walking the chain just burns every model and buries the real cause under
 * a slow failure the child experiences as "Ari is broken".
 */
function isQuotaExhausted(err: unknown): boolean {
  const e = read(err);
  return e.code === "insufficient_quota" || /insufficient_quota|exceeded your current quota|check your plan and billing/i.test(msg(err));
}

/** Ordinary per-minute rate limiting — a different model is a different bucket. */
function isRateLimited(err: unknown): boolean {
  const e = read(err);
  if (isQuotaExhausted(err)) return false; // the 429 that is NOT capacity
  return e.code === "rate_limit_exceeded" || e.status === 429 || /\b429\b|rate.?limit/i.test(msg(err));
}

/** Model id retired or mistyped — skip down the chain AND scream: prod is
 *  running on a configuration that no longer exists. */
export function isModelGone(err: unknown): boolean {
  const e = read(err);
  return e.code === "model_not_found" || (e.status === 404 && !!e.code) || /\b404\b|does not exist|model_not_found/i.test(msg(err));
}

/** Transient server-side or network failure. */
function isTransient(err: unknown): boolean {
  const e = read(err);
  if (e.status && [500, 502, 503, 504].includes(e.status)) return true;
  return /\b(500|502|503|504)\b|server_error|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|socket hang up|socket disconnected|\bterminated\b/i.test(
    msg(err),
  );
}

/** A safety verdict, never an outage (PRD-MODEL-FALLBACK §3.6). Retrying it on
 *  another provider is shopping for one that says yes — fail closed. */
function isContentFiltered(err: unknown): boolean {
  const e = read(err);
  // `ModerationBlockedError` is OUR verdict from the option-A moderation pass
  // (openai-generation.ts) and counts the same as a provider refusal: a block
  // is a decision about the content, and no other model can overturn it.
  // Matched by name rather than by import to keep this module free of the
  // generation/SDK surface it classifies errors for.
  if ((err as { name?: string } | null)?.name === "ModerationBlockedError") return true;
  return e.code === "content_filter" || /content_filter|content management policy|content policy/i.test(msg(err));
}

export const openaiAdapter: ProviderAdapter = {
  provider: "openai",

  isConfigured(env) {
    return !!env.OPENAI_API_KEY;
  },

  isModelGone,

  /**
   * Capacity, retired ids and transient infra move DOWN the chain; everything
   * else throws. Ordering matters: the content-filter and quota checks run
   * BEFORE the rate-limit check, because both can present as a status that
   * would otherwise read as retryable.
   *
   * Unrecognised errors return false by design — an unknown failure retried
   * across four models is how a real defect gets laundered into a timeout.
   */
  shouldTryNextModel(err) {
    if (isContentFiltered(err)) return false;
    if (isQuotaExhausted(err)) return false;
    return isRateLimited(err) || isModelGone(err) || isTransient(err);
  },
};
