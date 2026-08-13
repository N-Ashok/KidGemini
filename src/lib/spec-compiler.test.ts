// Pure-logic tests for spec-compiler.ts (Pass 1 of the two-pass pipeline,
// owner ask 2026-08-12). No network — see gemini.spec-compile.test.ts for the
// wired-up model call.
import { describe, it, expect } from "vitest";
import { specCompilerEnabled, specCompilerModel, shouldCompileSpec, SPEC_COMPILER_SYSTEM_PROMPT } from "./spec-compiler";
import type { ChatMessage } from "@/types/chat.types";

describe("specCompilerEnabled", () => {
  it("is OFF unless the flag is exactly \"1\" — the PRD is unapproved for live traffic", () => {
    expect(specCompilerEnabled({})).toBe(false);
    expect(specCompilerEnabled({ SPEC_COMPILER_ENABLED: "true" })).toBe(false);
    expect(specCompilerEnabled({ SPEC_COMPILER_ENABLED: "1" })).toBe(true);
  });
});

describe("specCompilerModel", () => {
  it("defaults to the newest lite-tier Google model (revised 2026-08-13 — DeepSeek stalled 30s, then 2.5-flash-lite 404'd in a Vertex region with no fallback)", () => {
    expect(specCompilerModel({})).toBe("gemini-3.5-flash-lite");
  });

  it("DeepSeek is available as an explicit opt-in", () => {
    expect(specCompilerModel({ SPEC_COMPILER_MODEL: "deepseek-v4-flash" })).toBe("deepseek-v4-flash");
  });
});

const gameHistory: ChatMessage[] = [{ id: "m1", role: "assistant", text: "here", artifactHtml: "<html></html>", createdAt: 1755000000000 }];

describe("shouldCompileSpec — eligibility (Pass 1 applies only to a fresh build)", () => {
  it("a bare one-line game idea is eligible", () => {
    expect(shouldCompileSpec({ message: "make me a lemonade game", history: [] })).toBe(true);
  });

  it("non-build chat is not eligible", () => {
    expect(shouldCompileSpec({ message: "hi how are you", history: [] })).toBe(false);
  });

  it("an image attachment is not eligible", () => {
    expect(
      shouldCompileSpec({ message: "make me a game", history: [], image: { mimeType: "image/png", data: "x" } }),
    ).toBe(false);
  });

  it("a forced in-place rebuild is not eligible", () => {
    expect(shouldCompileSpec({ message: "make me a game", history: [], forceRebuild: true })).toBe(false);
  });

  it("an edit turn (a game already exists) is not eligible", () => {
    expect(shouldCompileSpec({ message: "add a jump button to the game", history: gameHistory })).toBe(false);
  });

  it("a repeated identical request is not eligible", () => {
    const history: ChatMessage[] = [{ id: "m1", role: "child", text: "make me a game", createdAt: 1755000000000 }];
    expect(shouldCompileSpec({ message: "make me a game", history })).toBe(false);
  });
});

// BUG-FIX-LOG 2026-08-12 (a generated football game's "drag to kick" gesture
// fired from anywhere on screen, not just the ball): §6's mechanics rule
// asked for concrete numbers but never asked for a SPATIAL/targeting
// constraint on input mechanics — a relational fact, the same class §7/§8
// already demand for art/scene. The AI mechanics right next to it (defender
// speed, goalie confinement) were numeric and transferred fine; only the
// untargeted input mechanic broke.
describe("SPEC_COMPILER_SYSTEM_PROMPT — §6 requires a spatial/targeting constraint on input mechanics", () => {
  it("tells the compiler an interactive gesture must state what it has to be on/near to register", () => {
    expect(SPEC_COMPILER_SYSTEM_PROMPT).toMatch(/spatial constraint/i);
    expect(SPEC_COMPILER_SYSTEM_PROMPT).toMatch(/no named target/i);
  });
});

// BUG-FIX-LOG 2026-08-13 (the §6 fix above worked — a real generated football
// game got an explicit KICK_RANGE check — but its ball still came out at a
// 1:2 diameter-to-player-height ratio; a real ball is closer to 1:8). The
// prompt-catalog.ts fix gave two separate absolute numbers ("human ~1.7,
// ball ~0.22") but never stated the RATIO between them, so a model can
// reference "a human" and still get the proportion wrong.
describe("SPEC_COMPILER_SYSTEM_PROMPT — §8 requires an explicit size RATIO, not just absolute numbers", () => {
  it("tells the compiler to state object sizes as a ratio to the human reference", () => {
    expect(SPEC_COMPILER_SYSTEM_PROMPT).toMatch(/explicit ratio/i);
  });
});

// BUG-FIX-LOG 2026-08-13 (the same football game moved the player ONLY via
// `mousemove` — no keydown/keyup listener anywhere, and the touch kick
// button had no matching touch-move-to-walk handler, so it was very likely
// unplayable on a phone). §6 never required more than one input path.
describe("SPEC_COMPILER_SYSTEM_PROMPT — §6 requires multi-input support (keyboard + pointer/touch)", () => {
  it("tells the compiler every core mechanic must be reachable by at least two input methods", () => {
    expect(SPEC_COMPILER_SYSTEM_PROMPT).toMatch(/keyboard/i);
    expect(SPEC_COMPILER_SYSTEM_PROMPT).toMatch(/at least two|two input/i);
  });
});

// BUG-FIX-LOG 2026-08-13 (owner UAT of a real compiled spec, "River Nomad
// 3D"): §7 nailed the 3D scene's aesthetic (a real palette, a named
// low-poly style, a lighting mood) but its own "UI Styling" sub-bullet
// still defaulted to generic, genre-blind language — "rounded cards,
// subtle drop shadows, clean vector UI overlays" — completely disconnected
// from the canyon/river/crocodile world one paragraph above it. Owner's
// framing: that reads as a professional dashboard, correct for a strategy
// game, wrong for an immersive adventure. The rule must be a CONDITIONAL
// judgement call (genre-appropriate), never a blanket "always skin the UI".
describe("SPEC_COMPILER_SYSTEM_PROMPT — §7 requires the UI chrome itself to match the genre, not default to a generic dashboard", () => {
  it("tells the compiler to make an explicit clean-vs-themed call for the UI chrome, tied to genre", () => {
    expect(SPEC_COMPILER_SYSTEM_PROMPT).toMatch(/clean|dashboard/i);
    expect(SPEC_COMPILER_SYSTEM_PROMPT).toMatch(/genre/i);
  });

  it("names concrete themed-treatment examples instead of leaving it abstract", () => {
    expect(SPEC_COMPILER_SYSTEM_PROMPT).toMatch(/wood|leather|parchment|weathered|hand-/i);
  });
});

// BUG-FIX-LOG 2026-08-13 (round 2): the §7 UI-chrome fix above worked at the
// SPEC level — a real compiled spec correctly described "hand-carved
// weathered riverwood panel HUD with braided rope borders, rustic
// stamped-metal buttons" — but the real BUILT game ignored it entirely: the
// actual CSS was plain rgba(0,0,0,0.3-0.4) rounded panels, zero matches for
// wood/rope/rustic/weathered/stamped anywhere in 41KB of generated code.
// Prose description didn't transfer; per the PRD's own finding (§2.5),
// literal/quantified facts transfer far more reliably than descriptive ones.
// This asks the COMPILER to hand the builder actual CSS values to copy, not
// just words to interpret.
describe("SPEC_COMPILER_SYSTEM_PROMPT — §7 the UI chrome treatment must include literal CSS values the builder can copy, not just prose", () => {
  it("requires actual CSS property declarations for the chosen treatment, not only a description of it", () => {
    expect(SPEC_COMPILER_SYSTEM_PROMPT).toMatch(/literal CSS|actual CSS (declaration|value|propert)/i);
    expect(SPEC_COMPILER_SYSTEM_PROMPT).toMatch(/border|background|box-shadow/i);
  });
});
