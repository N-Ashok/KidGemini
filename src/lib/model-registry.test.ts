// Pins the cross-provider, price-ordered chain policy (owner decision
// 2026-07-20). Two rules do the work: same tier = interchangeable, so order by
// real cost; and a model whose provider can't enforce child-safety thresholds
// never enters a chain unless someone opted in explicitly.
import { describe, expect, it } from "vitest";
import { MAX_EXPLICIT_CHAIN, MODEL_CATALOG, chainFor, referenceCostUsd, specFor } from "./model-registry";
import type { CapabilityTier } from "@/types/model-provider.types";

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

  it("R.2b the 2026-08-18 ladder is fully catalogued (closes TECH_DEBT #104)", () => {
    // Owner decision 2026-08-18: primary gemini-3.6-flash, then 3.7-flash,
    // 3.5-flash, 3.1-pro-preview, 3.5-flash-lite. An id that is NOT here makes
    // specFor() miss, which silently drops GeminiChatModel to the legacy
    // Gemini-only ladder AND bills it at the unknown-model fallback rate.
    // Prices verified against ai.google.dev/gemini-api/docs/pricing 2026-08-18.
    const expected: Record<string, [CapabilityTier, number, number, number]> = {
      "gemini-3.7-flash": ["frontier", 0.75, 3.75, 0.075],
      "gemini-3.6-flash": ["workhorse", 0.75, 3.75, 0.075],
      "gemini-3.1-pro-preview": ["frontier", 2.0, 12.0, 0.2],
      "gemini-3.5-flash-lite": ["lite", 0.3, 2.5, 0.03],
    };
    for (const [id, [tier, inp, out, cached]] of Object.entries(expected)) {
      const spec = specFor(id);
      expect(spec, `${id} missing from MODEL_CATALOG`).toBeDefined();
      expect(spec!.tier, id).toBe(tier);
      expect(spec!.inputPerMTok, id).toBe(inp);
      expect(spec!.outputPerMTok, id).toBe(out);
      expect(spec!.cachedInputPerMTok, id).toBe(cached);
      expect(spec!.safety, id).toBe("provider-enforced");
    }
  });

  it("R.2c the new primary is cheaper per reference turn than the one it replaces", () => {
    // The owner's ask in one assertion: "sparks to be reduced and not more".
    expect(referenceCostUsd(specFor("gemini-3.6-flash")!))
      .toBeLessThan(referenceCostUsd(specFor("gemini-3.5-flash")!));
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
    // 2026-08-18: gemini-3.7-flash ($0.75/$3.75) is now the cheapest frontier
    // model in the catalog, so it heads the chain ahead of gpt-5.6-luna.
    expect(chain[0]).toBe("gemini-3.7-flash");
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

// DeepSeek (owner ask 2026-08-12) is prompt-only and China-based, exactly like
// Kimi — so "functional in the fallback" means REACHABLE when both gates are
// open, not routable by default. These pin that it joined the chain machinery
// without joining the default routing.
describe("DeepSeek — prompt-only, doubly gated", () => {
  const withDeepSeek = (env: Record<string, string | undefined>) =>
    chainFor({ primary: "gemini-3.5-flash", tier: "frontier", env: { ...env, MODEL_FALLBACK_CHAIN: "deepseek-reasoner,deepseek-chat" } });

  it("R.25 the catalog carries the DeepSeek ids, marked prompt-only", () => {
    for (const id of ["deepseek-reasoner", "deepseek-chat"]) {
      expect(specFor(id), id).toBeDefined();
      expect(specFor(id)!.provider, id).toBe("deepseek");
      expect(specFor(id)!.safety, id).toBe("prompt-only");
    }
  });

  it("R.26 excluded by default even with DEEPSEEK_API_KEY set (the opt-in flag is missing)", () => {
    expect(withDeepSeek({ GEMINI_API_KEY: "g", DEEPSEEK_API_KEY: "d" })).toEqual([]);
  });

  it("R.27 excluded when the flag is set but DEEPSEEK_API_KEY is missing", () => {
    expect(withDeepSeek({ GEMINI_API_KEY: "g", ALLOW_PROMPT_ONLY_SAFETY_MODELS: "1" })).toEqual([]);
  });

  it("R.28 admitted only with BOTH the opt-in flag AND the key", () => {
    const chain = withDeepSeek({ GEMINI_API_KEY: "g", DEEPSEEK_API_KEY: "d", ALLOW_PROMPT_ONLY_SAFETY_MODELS: "1" });
    expect(chain).toEqual(["deepseek-reasoner", "deepseek-chat"]);
  });

  it("R.29 never enters the AUTO chain without the flag, however cheap it is", () => {
    // deepseek-chat undercuts every workhorse in the catalog, so if price could
    // beat the safety gate this is the row that would prove it.
    const auto = chainFor({
      primary: "gemini-3.5-flash",
      tier: "frontier",
      env: { GEMINI_API_KEY: "g", DEEPSEEK_API_KEY: "d" },
    });
    expect(auto.some((id) => id.startsWith("deepseek"))).toBe(false);
  });
});

// The Vertex switch (owner ask 2026-08-12) changes which env var holds the
// Google credential. The chain must not treat a cut-over box as "Google not
// configured" — that would empty the Google side of every chain at the exact
// moment the operator believed they had a working backend.
describe("Google credential — either backend's key counts", () => {
  it("R.30 Google models stay routable on a Vertex-only box (VERTEX_API_KEY, no GEMINI_API_KEY)", () => {
    const chain = chainFor({
      primary: "gemini-3.5-flash",
      tier: "frontier",
      env: { GEMINI_BACKEND: "vertex", VERTEX_API_KEY: "v" },
    });
    expect(chain.length).toBeGreaterThan(0);
    expect(chain.every((id) => id.startsWith("gemini-"))).toBe(true);
  });

  it("R.31 with NEITHER Google key, Google is still dropped entirely", () => {
    const chain = chainFor({
      primary: "gpt-5.6-luna",
      tier: "frontier",
      env: { OPENAI_API_KEY: "o" },
    });
    expect(chain.some((id) => id.startsWith("gemini-"))).toBe(false);
  });
});

// The production ladder the owner pinned on 2026-08-18. The primary is a
// WORKHORSE model, so the automatic rule would refuse to escalate to the
// frontier 3.7 / 3.1-pro rescues — this chain only works because an explicit
// MODEL_FALLBACK_CHAIN is allowed to reach a richer tier (R.16). If that ever
// regresses, prod quietly loses its two best rescues on a Gemini outage.
describe("the pinned 2026-08-18 production chain", () => {
  it("R.26 resolves in the exact owner-specified order behind a 3.6-flash primary", () => {
    const chain = chainFor({
      primary: "gemini-3.6-flash",
      tier: "workhorse",
      env: {
        GEMINI_API_KEY: "g",
        MODEL_FALLBACK_CHAIN:
          "gemini-3.7-flash,gemini-3.5-flash,gemini-3.1-pro-preview,gemini-3.5-flash-lite",
      },
    });
    expect(chain).toEqual([
      "gemini-3.7-flash", "gemini-3.5-flash", "gemini-3.1-pro-preview", "gemini-3.5-flash-lite",
    ]);
  });

  it("R.27 without the pin, the AUTO chain never escalates to a pricier tier", () => {
    // Documented policy (PRD-MODEL-FALLBACK §4): falling UP in price during an
    // incident is how a 503 becomes a bill shock. Pinning is the deliberate
    // exception, and it has to be deliberate.
    const auto = chainFor({ primary: "gemini-3.6-flash", tier: "workhorse", env: { GEMINI_API_KEY: "g" } });
    expect(auto).not.toContain("gemini-3.7-flash");
    expect(auto).not.toContain("gemini-3.1-pro-preview");
  });
});
