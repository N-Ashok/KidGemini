// Model fallback chain (PRD-MODEL-FALLBACK §2, owner decision 2026-07-11:
// FOUR fallbacks). Pure logic, no SDK — gemini.ts walks the chain.
//
// Latency guard: the primary keeps its normal retries, but each fallback gets
// ONE attempt — a full incident walks 5 models in ~5 tries, not 15.

/** Ordered fallback pool, best-first (owner-specified chain 2026-07-11:
 *  3.5-flash primary → 3-flash-preview → 2.5-flash → 2.5-flash-lite).
 *  "gemini-3-flash-preview" is the Dec-2025 preview id that 3.5-flash
 *  replaced — still serving, no announced shutdown. A retired id costs one
 *  fast 404 and the chain moves on (isModelGone), so this list may outlive
 *  Google's lineup. */
const DEFAULT_CHAIN = [
  "gemini-3-flash-preview",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
];

export const MAX_FALLBACKS = 4;

/**
 * The models to try AFTER the primary, in order. Env override:
 * GEMINI_FALLBACK_MODELS="a,b,c,d" (capped at 4); legacy single
 * GEMINI_FALLBACK_MODEL is honored as a one-model chain. The primary and
 * duplicates are filtered out — a fallback that IS the primary is a no-op
 * that would just re-enter the same overloaded pool.
 */
export function fallbackChain(primary: string, env: Record<string, string | undefined>): string[] {
  const raw = env.GEMINI_FALLBACK_MODELS ?? env.GEMINI_FALLBACK_MODEL;
  const pool = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_CHAIN;
  return [...new Set(pool)].filter((m) => m !== primary).slice(0, MAX_FALLBACKS);
}

/** Google-side capacity refusal — a DIFFERENT model pool can absorb this. */
export function isOverloaded(err: unknown): boolean {
  return /\b503\b|UNAVAILABLE|high demand|overloaded|\b429\b|RESOURCE_EXHAUSTED/i.test(
    (err as Error)?.message ?? "",
  );
}

/** The model id no longer exists (Google deprecation) — skip down the chain,
 *  and scream in the logs: prod is running on a retired configuration. */
export function isModelGone(err: unknown): boolean {
  return /\b404\b|NOT_FOUND|is not found|not supported/i.test((err as Error)?.message ?? "");
}

/** Chain policy: capacity problems and retired models move DOWN the chain;
 *  everything else (safety, auth, 400s) throws immediately — fallback must
 *  never mask a real defect or dodge a safety verdict. */
export function shouldTryNextModel(err: unknown): boolean {
  return isOverloaded(err) || isModelGone(err);
}
