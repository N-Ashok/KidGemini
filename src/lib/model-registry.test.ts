// Pins the cross-provider, price-ordered chain policy (owner decision
// 2026-07-20). Two rules do the work: same tier = interchangeable, so order by
// real cost; and a model whose provider can't enforce child-safety thresholds
// never enters a chain unless someone opted in explicitly.
import { describe, expect, it } from "vitest";
import { MAX_EXPLICIT_CHAIN, MODEL_CATALOG, chainFor, referenceCostUsd, specFor } from "./model-registry";

const KEYS = { GEMINI_API_KEY: "g", OPENAI_API_KEY: "o" };

describe("catalog integrity", () => {
  it("R.1 every model has a price, a tier and an explicit safety posture", () => {
    for (const m of MODEL_CATALOG) {
      expect(m.inputPerMTok, m.id).toBeGreaterThan(0);
      expect(m.outputPerMTok, m.id).toBeGreaterThan(0);
      expect(["frontier", "workhorse", "lite"], m.id).toContain(m.tier);
      expect(["provider-enforced", "prompt-only"], m.id).toContain(m.safety);
    }
  });

  it("R.2 model ids are unique — a duplicate would make chain order ambiguous", () => {
    const ids = MODEL_CATALOG.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("chainFor — price-ordered within a tier", () => {
  it("R.3 within one tier, orders by real reference-turn cost, cheapest first", () => {
    const chain = chainFor({ primary: "gemini-3-flash-preview", tier: "workhorse", env: KEYS })
      .filter((id) => specFor(id)!.tier === "workhorse");
    const costs = chain.map((m) => referenceCostUsd(specFor(m)!));
    expect(costs).toEqual([...costs].sort((a, b) => a - b));
  });

  it("R.14 quality outranks price: a frontier turn tries every frontier model BEFORE any lite one", () => {
    // Regression on the first cut of this sort — pure cheapest-first put
    // flash-lite at the head of a game-BUILD chain, which is a worse game.
    const chain = chainFor({ primary: "gemini-3.5-flash", tier: "frontier", env: KEYS });
    const tiers = chain.map((id) => specFor(id)!.tier);
    const ranks = tiers.map((t) => ["frontier", "workhorse", "lite"].indexOf(t));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b)); // never climbs back up
    expect(chain[0]).toBe("gpt-5.6-luna"); // the only other frontier model
  });

  it("R.4 crosses providers once permitted — gpt-5.6-luna ($1/$6) beats gemini-3.5-flash ($1.5/$9) at the same tier", () => {
    // The whole point of the rewrite: the cheaper equal-tier model wins even
    // though it belongs to a different provider.
    const chain = chainFor({ primary: "gemini-3.5-flash", tier: "frontier", env: KEYS });
    expect(chain).toContain("gpt-5.6-luna");
    expect(specFor("gpt-5.6-luna")?.provider).toBe("openai");
    // …and it outranks the Google frontier model on real reference cost.
    expect(referenceCostUsd(specFor("gpt-5.6-luna")!)).toBeLessThan(referenceCostUsd(specFor("gemini-3.5-flash")!));
  });

  it("R.4b OpenAI is reachable by default now that its moderation pass is wired (2026-07-20)", () => {
    // Before the moderation adapter existed these entries were `prompt-only`
    // and the gate excluded them. They are `provider-enforced` only because
    // OpenAIGenerator moderates input AND output around every call.
    const chain = chainFor({ primary: "gemini-3.5-flash", tier: "frontier", env: KEYS });
    expect(chain.some((id) => specFor(id)!.provider === "openai")).toBe(true);
  });

  it("R.5 never includes the primary — that re-enters the same saturated pool", () => {
    const chain = chainFor({ primary: "gemini-2.5-flash", tier: "workhorse", env: KEYS });
    expect(chain).not.toContain("gemini-2.5-flash");
  });

  it("R.6 a cheaper tier is allowed as a deeper rescue, never a richer one", () => {
    // Falling UP in price mid-incident is how a 503 turns into a bill shock;
    // falling DOWN in quality is the documented trade (PRD-MODEL-FALLBACK §4).
    const chain = chainFor({ primary: "gemini-3-flash-preview", tier: "workhorse", env: KEYS });
    for (const id of chain) {
      expect(specFor(id)!.tier === "workhorse" || specFor(id)!.tier === "lite", id).toBe(true);
    }
  });

  it("R.7 drops models whose provider has no API key — discovered now, not mid-incident", () => {
    const chain = chainFor({ primary: "gemini-3.5-flash", tier: "frontier", env: { GEMINI_API_KEY: "g" } });
    expect(chain.every((id) => specFor(id)!.provider === "google")).toBe(true);
  });
});

// The gate is exercised against a SYNTHETIC catalog on purpose: every real
// entry is `provider-enforced` today, so testing against MODEL_CATALOG would
// pass vacuously and stop protecting anything. These pin the MECHANISM, which
// has to work the day a prompt-only provider (Kimi, a new adapter) is added.
const GATED = [
  { id: "safe-model", provider: "google", tier: "frontier", inputPerMTok: 1, outputPerMTok: 5, safety: "provider-enforced" },
  { id: "unguarded-model", provider: "google", tier: "frontier", inputPerMTok: 0.01, outputPerMTok: 0.02, safety: "prompt-only" },
] as never;

describe("child-safety gate — fail closed", () => {
  const gated = (env: Record<string, string | undefined>) =>
    chainFor({ primary: "primary-x", tier: "frontier", env, catalog: GATED });

  it("R.8 a prompt-only model is EXCLUDED by default even though it is far cheaper", () => {
    expect(gated(KEYS)).toEqual(["safe-model"]);
  });

  it("R.9 it enters only with the explicit opt-in flag", () => {
    const opted = gated({ ...KEYS, ALLOW_PROMPT_ONLY_SAFETY_MODELS: "1" });
    expect(opted).toContain("unguarded-model");
    expect(opted[0]).toBe("unguarded-model"); // …and price-orders normally once allowed
  });

  it("R.10 the opt-in is exact — any value other than \"1\" stays closed", () => {
    for (const v of ["", "0", "true", "yes", "TRUE", " 1"]) {
      expect(gated({ ...KEYS, ALLOW_PROMPT_ONLY_SAFETY_MODELS: v }), v).toEqual(["safe-model"]);
    }
  });

  it("R.11 an explicit MODEL_FALLBACK_CHAIN cannot smuggle a prompt-only model past the gate", () => {
    const chain = chainFor({
      primary: "primary-x", tier: "frontier", catalog: GATED,
      env: { ...KEYS, MODEL_FALLBACK_CHAIN: "unguarded-model,safe-model" },
    });
    expect(chain).toEqual(["safe-model"]);
  });
});

describe("env override", () => {
  it("R.12 unknown ids in the override are dropped, not passed to a provider", () => {
    const chain = chainFor({
      primary: "gemini-3.5-flash",
      tier: "frontier",
      env: { ...KEYS, MODEL_FALLBACK_CHAIN: "not-a-real-model,gemini-2.5-flash" },
    });
    expect(chain).toEqual(["gemini-2.5-flash"]);
  });

  it("R.13 chain depth is capped — an incident walks a few models, not the catalog", () => {
    const chain = chainFor({ primary: "gemini-3.5-flash", tier: "frontier", env: KEYS });
    expect(chain.length).toBeLessThanOrEqual(4);
  });
});

// An explicit MODEL_FALLBACK_CHAIN is a deliberate operator act: it overrides
// the tier/price HEURISTIC but never the safety or configured-provider gates.
describe("explicit MODEL_FALLBACK_CHAIN — operator intent", () => {
  const pin = (chain: string, extra: Record<string, string> = {}) =>
    chainFor({
      primary: "gemini-3-flash-preview",
      tier: "workhorse",
      env: { ...KEYS, MODEL_FALLBACK_CHAIN: chain, ...extra },
    });

  it("R.15 keeps the pinned ORDER exactly — no price re-sorting", () => {
    expect(pin("gemini-2.5-flash-lite,gpt-5.6-luna,gemini-2.5-flash")).toEqual([
      "gemini-2.5-flash-lite", "gpt-5.6-luna", "gemini-2.5-flash",
    ]);
  });

  it("R.16 may include a RICHER tier the auto rule would skip (the 07-13 quality escalation)", () => {
    // Behind a workhorse primary the automatic chain excludes frontier models;
    // pinning one is how the old ladder's premium deep fallback is restored.
    expect(pin("gemini-3.5-flash")).toEqual(["gemini-3.5-flash"]);
  });

  it("R.17 interleaves providers exactly as written", () => {
    expect(pin("gpt-5.4-mini,gemini-2.5-flash,gpt-5.4-nano,gemini-3.5-flash,gpt-5.6-luna,gemini-2.5-flash-lite")).toEqual([
      "gpt-5.4-mini", "gemini-2.5-flash", "gpt-5.4-nano",
      "gemini-3.5-flash", "gpt-5.6-luna", "gemini-2.5-flash-lite",
    ]);
  });

  it("R.18 still drops the primary, unknown ids, and duplicates", () => {
    expect(pin("gemini-3-flash-preview,nope-9000,gemini-2.5-flash,gemini-2.5-flash"))
      .toEqual(["gemini-2.5-flash"]);
  });

  it("R.19 a provider with no key is still dropped, even when pinned", () => {
    const chain = chainFor({
      primary: "gemini-3-flash-preview", tier: "workhorse",
      env: { GEMINI_API_KEY: "g", MODEL_FALLBACK_CHAIN: "gpt-5.4-mini,gemini-2.5-flash" },
    });
    expect(chain).toEqual(["gemini-2.5-flash"]);
  });

  it("R.20 an explicit chain may go deeper than the auto cap, but is still bounded", () => {
    const long = MODEL_CATALOG.map((m) => m.id).join(",");
    expect(pin(long).length).toBeLessThanOrEqual(MAX_EXPLICIT_CHAIN);
  });
});

// Claude + Kimi (owner decision 2026-07-20, "extend to Claude and Kimi"). Both
// are prompt-only, so they must obey the SAME fail-closed gate as any other
// prompt-only provider: excluded unless ALLOW_PROMPT_ONLY_SAFETY_MODELS=1 AND
// their provider key is present. Uses an explicit chain so the assertion is
// deterministic (they're expensive, so they'd otherwise fall past MAX_CHAIN).
describe("Claude + Kimi providers — prompt-only, doubly gated", () => {
  const withClaude = (env: Record<string, string | undefined>) =>
    chainFor({ primary: "gemini-3.5-flash", tier: "frontier", env: { ...env, MODEL_FALLBACK_CHAIN: "claude-sonnet-5,kimi-k2" } });

  it("R.20 the catalog carries Claude + Kimi ids, all marked prompt-only", () => {
    for (const id of ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5-20251001", "kimi-k2", "moonshot-v1-32k", "moonshot-v1-8k"]) {
      expect(specFor(id), id).toBeDefined();
      expect(specFor(id)!.safety, id).toBe("prompt-only");
    }
  });

  it("R.21 excluded by default even with their keys set (the opt-in flag is missing)", () => {
    expect(withClaude({ GEMINI_API_KEY: "g", ANTHROPIC_API_KEY: "a", MOONSHOT_API_KEY: "m" })).toEqual([]);
  });

  it("R.22 excluded when the flag is set but the provider key is missing", () => {
    // flag on, but no ANTHROPIC/MOONSHOT keys → still dropped (key gate)
    expect(withClaude({ GEMINI_API_KEY: "g", ALLOW_PROMPT_ONLY_SAFETY_MODELS: "1" })).toEqual([]);
  });

  it("R.23 admitted only with BOTH the opt-in flag AND the provider key", () => {
    const chain = withClaude({
      GEMINI_API_KEY: "g", ANTHROPIC_API_KEY: "a", MOONSHOT_API_KEY: "m", ALLOW_PROMPT_ONLY_SAFETY_MODELS: "1",
    });
    expect(chain).toContain("claude-sonnet-5");
    expect(chain).toContain("kimi-k2");
  });

  it("R.24 Claude admitted but Kimi still blocked when only Anthropic's key is set", () => {
    const chain = withClaude({ GEMINI_API_KEY: "g", ANTHROPIC_API_KEY: "a", ALLOW_PROMPT_ONLY_SAFETY_MODELS: "1" });
    expect(chain).toContain("claude-sonnet-5");
    expect(chain).not.toContain("kimi-k2");
  });
});
