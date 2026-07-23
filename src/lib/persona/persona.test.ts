// Persona registry (PRD-BIBLE-TEACHER §6). The persona is a SERVER-AUTHORITATIVE
// switch over the child-safe default: it selects the system prompt, the Gemini
// safety thresholds, and the input-rule mode for a turn. resolvePersona is the
// trust boundary — it must FAIL CLOSED to the child default unless the session
// is a verified adult, so a client can never opt into the relaxed authoring
// posture by sending a flag alone.

import { describe, it, expect, vi } from "vitest";

// persona.ts pulls the harm enums from @google/genai; mock them to plain
// strings so the config assertions read cleanly (same shape the real SDK
// resolves to at runtime — see gemini.safety-config.test.ts).
vi.mock("server-only", () => ({}));
vi.mock("@google/genai", () => ({
  HarmCategory: {
    HARM_CATEGORY_HARASSMENT: "h",
    HARM_CATEGORY_HATE_SPEECH: "hs",
    HARM_CATEGORY_SEXUALLY_EXPLICIT: "se",
    HARM_CATEGORY_DANGEROUS_CONTENT: "dc",
  },
  HarmBlockThreshold: { BLOCK_LOW_AND_ABOVE: "low", BLOCK_MEDIUM_AND_ABOVE: "med" },
}));

import { PERSONAS, resolvePersona, type PersonaConfig } from "./persona";

const thresholds = (p: PersonaConfig) =>
  Object.fromEntries(p.safetySettings.map((s) => [s.category, s.threshold]));

describe("resolvePersona — fail-closed to child default", () => {
  it("adult session + requested bible-teacher → bible-teacher persona", () => {
    expect(resolvePersona("bible-teacher", { adult: true }).id).toBe("bible-teacher");
  });

  it("requested bible-teacher but session is NOT adult → default (fail closed)", () => {
    expect(resolvePersona("bible-teacher", { adult: false }).id).toBe("default");
  });

  it("requested bible-teacher but NO session (guest) → default", () => {
    expect(resolvePersona("bible-teacher", null).id).toBe("default");
  });

  it("requested bible-teacher but session missing the adult claim → default", () => {
    expect(resolvePersona("bible-teacher", {}).id).toBe("default");
  });

  it("adult session but NO persona requested → default (adulthood alone never opts in)", () => {
    expect(resolvePersona(undefined, { adult: true }).id).toBe("default");
  });

  it("adult session but an unknown/garbage persona string → default", () => {
    expect(resolvePersona("hacker", { adult: true }).id).toBe("default");
  });

  it("default is always requestable by anyone", () => {
    expect(resolvePersona("default", null).id).toBe("default");
  });
});

describe("persona safety posture (pinned)", () => {
  it("bible-teacher requires an adult session; default does not", () => {
    expect(PERSONAS["bible-teacher"].requiresAdult).toBe(true);
    expect(PERSONAS.default.requiresAdult).toBe(false);
  });

  it("default persona runs the child input-rule mode; bible-teacher the adult mode", () => {
    expect(PERSONAS.default.inputRuleMode).toBe("child");
    expect(PERSONAS["bible-teacher"].inputRuleMode).toBe("adult");
  });

  // The HATE_SPEECH LOW→MEDIUM relaxation (2026-07-22) is now SCOPED to the
  // teacher persona; the child default is tightened back to the strictest.
  it("child default keeps HATE_SPEECH at the STRICTEST (LOW) — relaxation re-scoped away", () => {
    expect(thresholds(PERSONAS.default).hs).toBe("low");
  });

  it("bible-teacher relaxes HATE_SPEECH to MEDIUM (benign faith content latitude)", () => {
    expect(thresholds(PERSONAS["bible-teacher"]).hs).toBe("med");
  });

  it("SEXUALLY_EXPLICIT stays STRICTEST (LOW) in BOTH personas — never relaxed", () => {
    expect(thresholds(PERSONAS.default).se).toBe("low");
    expect(thresholds(PERSONAS["bible-teacher"]).se).toBe("low");
  });

  it("HARASSMENT stays STRICTEST (LOW) in both personas", () => {
    expect(thresholds(PERSONAS.default).h).toBe("low");
    expect(thresholds(PERSONAS["bible-teacher"]).h).toBe("low");
  });

  it("DANGEROUS_CONTENT stays MEDIUM in both (game-genre allowance, unchanged)", () => {
    expect(thresholds(PERSONAS.default).dc).toBe("med");
    expect(thresholds(PERSONAS["bible-teacher"]).dc).toBe("med");
  });
});
