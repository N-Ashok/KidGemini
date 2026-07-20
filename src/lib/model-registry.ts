// The cross-provider model catalog and the price-ordered chain derived from it
// (owner decision 2026-07-20, superseding PRD-MODEL-FALLBACK §7's non-goal).
//
// Policy, in one line: models in the same capability tier are interchangeable,
// so walk them CHEAPEST FIRST and cross providers freely — but never past the
// child-safety gate below.
//
// Pure logic, no SDK: adapters own the API calls, this owns "which model next".

import type { CapabilityTier, ModelSpec } from "@/types/model-provider.types";

/**
 * Every routable model, with the facts the chain needs.
 *
 * Gemini prices: pricing.config.ts (verified 2026-07-13 against
 * ai.google.dev/gemini-api/docs/pricing) — kept in sync there, which stays the
 * single source for the cost dashboard.
 * OpenAI prices: developers.openai.com/api/docs/pricing (read 2026-07-20).
 *
 * `safety` is the load-bearing field — see SafetyPosture in the types file.
 * OpenAI has moderation as a SEPARATE endpoint, not per-request thresholds on
 * the generation call, so these are honestly `prompt-only` until an adapter
 * actually wires a pre/post moderation pass. Marking them `provider-enforced`
 * to unlock cheaper routing would be lying to the gate that protects the kids.
 */
export const MODEL_CATALOG: ModelSpec[] = [
  // ── Google ────────────────────────────────────────────────────────────────
  { id: "gemini-3.5-flash", provider: "google", tier: "frontier", inputPerMTok: 1.5, outputPerMTok: 9.0, cachedInputPerMTok: 0.15, safety: "provider-enforced" },
  { id: "gemini-3-flash-preview", provider: "google", tier: "workhorse", inputPerMTok: 0.5, outputPerMTok: 3.0, cachedInputPerMTok: 0.05, safety: "provider-enforced" },
  { id: "gemini-2.5-flash", provider: "google", tier: "workhorse", inputPerMTok: 0.3, outputPerMTok: 2.5, cachedInputPerMTok: 0.03, safety: "provider-enforced" },
  { id: "gemini-2.5-flash-lite", provider: "google", tier: "lite", inputPerMTok: 0.1, outputPerMTok: 0.4, cachedInputPerMTok: 0.01, safety: "provider-enforced" },

  // ── OpenAI ────────────────────────────────────────────────────────────────
  // `provider-enforced` as of 2026-07-20 because every OpenAI generation goes
  // through OpenAIGenerator (providers/openai-generation.ts), which moderates
  // the child's message BEFORE the model sees it and the answer BEFORE the
  // child sees it. That pair is the stand-in for Gemini's per-request
  // safetySettings. If a code path is ever added that calls OpenAI WITHOUT
  // that wrapper, this flag becomes a lie and these must go back to
  // `prompt-only` — the gate trusts it and does not re-check.
  { id: "gpt-5.6-luna", provider: "openai", tier: "frontier", inputPerMTok: 1.0, outputPerMTok: 6.0, safety: "provider-enforced" },
  { id: "gpt-5.4-mini", provider: "openai", tier: "workhorse", inputPerMTok: 0.75, outputPerMTok: 4.5, safety: "provider-enforced" },
  { id: "gpt-5.4-nano", provider: "openai", tier: "lite", inputPerMTok: 0.2, outputPerMTok: 1.25, safety: "provider-enforced" },
];

/** Which env var proves a provider is usable. Missing key → its models are
 *  dropped when the chain is BUILT, so a failover never discovers the gap. */
const PROVIDER_KEY: Record<string, string> = {
  google: "GEMINI_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  moonshot: "MOONSHOT_API_KEY",
};

/** Cheaper tiers are valid deeper rescues; richer ones are not. Falling UP in
 *  price during an incident is how a 503 becomes a bill shock — falling down
 *  in quality is the documented, self-healing-covered trade
 *  (PRD-MODEL-FALLBACK §4). */
const TIER_ORDER: CapabilityTier[] = ["frontier", "workhorse", "lite"];

/** A representative game-build turn, used ONLY to rank models by real blended
 *  cost. Sorting on input or output price alone mis-ranks models whose ratios
 *  differ (gpt-5.4-nano is 2x gemini-lite's input but 3x its output). Shape is
 *  a long system prompt + history against a full HTML game back; adjust with
 *  real usage data — COST_TOKEN_BUDGET.md has the measured distributions. */
const REFERENCE_TURN = { prompt: 8000, output: 4000, cached: 4000 };

/**
 * Blended USD for REFERENCE_TURN on this model — the sort key, nothing else.
 *
 * Deliberately computed from the SPEC rather than via pricing.config's
 * estimateCostUsd(): that helper looks prices up in MODEL_PRICING, which lists
 * Gemini only, so every OpenAI model resolved to the unknown-model fallback
 * rate ($1.5/$9) and ranked as if it were the most expensive Google model.
 * Caught by R.4 before this shipped.
 *
 * KNOWN GAP (follow-up, not fixed here): that same lookup means the admin cost
 * dashboard will mis-bill any non-Gemini turn at $1.5/$9 — the identical class
 * of bug as BUG-FIX-LOG 2026-07-13 ("the primary model was MISSING here, so
 * the whole dashboard reported $0"). Fixing it properly means deriving
 * MODEL_PRICING from MODEL_CATALOG so there is ONE price source; that touches
 * the cost pipeline and wants its own change + tests. Nothing bills through a
 * non-Gemini model until the safety gate opens, so the gap is not yet live.
 */
export function referenceCostUsd(spec: ModelSpec): number {
  const cached = Math.min(REFERENCE_TURN.cached, REFERENCE_TURN.prompt);
  const cachedRate = spec.cachedInputPerMTok ?? spec.inputPerMTok * 0.25;
  return (
    ((REFERENCE_TURN.prompt - cached) / 1_000_000) * spec.inputPerMTok +
    (cached / 1_000_000) * cachedRate +
    (REFERENCE_TURN.output / 1_000_000) * spec.outputPerMTok
  );
}

export function specFor(id: string): ModelSpec | undefined {
  return MODEL_CATALOG.find((m) => m.id === id);
}

/** Ari is for 7–14 year olds: a model whose provider enforces no safety
 *  thresholds keeps only our input rules + system prompt (CLAUDE.md §3). It is
 *  excluded unless someone typed exactly "1" — an explicit, greppable act. */
function safetyAllows(spec: ModelSpec, env: Record<string, string | undefined>): boolean {
  return spec.safety === "provider-enforced" || env.ALLOW_PROMPT_ONLY_SAFETY_MODELS === "1";
}

/**
 * Depth cap for the AUTO-DERIVED chain. Latency the kid feels is the reason it
 * is small: each slot can burn a full CHAT_TIMEOUT_MS before moving on, so a
 * total outage walks the chain in ~a handful of tries (PRD-MODEL-FALLBACK §2).
 * An explicit MODEL_FALLBACK_CHAIN may go deeper — see MAX_EXPLICIT_CHAIN.
 */
export const MAX_CHAIN = 4;

/**
 * Depth cap when an operator pins the order themselves. Higher because an
 * explicit chain is a deliberate act, but still bounded — at ~30s per slot a
 * 6-deep chain is a ~3-minute worst case, which no child will wait through.
 * If you pin a long chain, shorten the per-call timeout to match.
 */
export const MAX_EXPLICIT_CHAIN = 8;

/**
 * The models to try AFTER `primary`, cheapest first.
 *
 * Filters, in order: same-or-cheaper tier → provider actually configured →
 * safety gate → not the primary → dedupe → cap. `MODEL_FALLBACK_CHAIN` (comma
 * separated ids) overrides the ORDER but not the gates — an operator can tune
 * routing under load without being able to switch the safety floor off by
 * accident.
 */
export function chainFor(opts: {
  primary: string;
  tier: CapabilityTier;
  env: Record<string, string | undefined>;
  /** Override the catalog. Exists so the SAFETY GATE stays under test even
   *  when every real entry is `provider-enforced` — otherwise those tests go
   *  vacuously green and the gate rots until the day someone adds a
   *  prompt-only provider and discovers it never worked. */
  catalog?: ModelSpec[];
}): string[] {
  const { primary, tier, env, catalog = MODEL_CATALOG } = opts;
  const minTierIdx = TIER_ORDER.indexOf(tier);

  // Gates that apply NO MATTER HOW the chain is chosen. The safety gate and
  // the configured-provider check are correctness, not heuristics — an
  // explicit override must not be able to route around either.
  const permitted = catalog.filter(
    (m) => !!env[PROVIDER_KEY[m.provider] ?? ""] && safetyAllows(m, env) && m.id !== primary,
  );
  // The tier rule is the AUTO-ordering heuristic only.
  const eligible = permitted.filter((m) => TIER_ORDER.indexOf(m.tier) >= minTierIdx);

  const override = env.MODEL_FALLBACK_CHAIN?.split(",").map((s) => s.trim()).filter(Boolean);
  if (override) {
    // Resolved against `permitted`, NOT `eligible`: pinning the order is a
    // deliberate operator act, so it may include a richer tier the automatic
    // rule would skip (e.g. escalating to gemini-3.5-flash behind a workhorse
    // primary — the 2026-07-13 ladder's quality rescue). Unknown ids are still
    // DROPPED rather than forwarded: an unrecognised string would reach a
    // provider SDK as a 404 and be silently skipped, the exact failure this
    // registry exists to remove.
    const picked = override
      .map((id) => permitted.find((m) => m.id === id))
      .filter((m): m is ModelSpec => !!m);
    return [...new Set(picked.map((m) => m.id))].slice(0, MAX_EXPLICIT_CHAIN);
  }

  const ordered =
    // QUALITY first, then price WITHIN that quality — the owner's rule is
      // "when they are all the same [performance], go by price", not "always
      // cheapest". Sorting on price alone filled all 4 slots with the cheapest
      // models in the catalog, so a failed frontier BUILD turn fell straight to
      // flash-lite and shipped a visibly worse game (caught by R.4/R.14).
      // Richer tiers are already filtered out above, so this descends in
      // quality only as slots allow, cheapest-first inside each rung.
      [...eligible].sort(
        (a, b) =>
          TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) ||
          referenceCostUsd(a) - referenceCostUsd(b),
      );

  return [...new Set(ordered.map((m) => m.id))].slice(0, MAX_CHAIN);
}
