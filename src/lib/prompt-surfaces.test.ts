import { describe, it, expect } from "vitest";
import { artifactPromptSurfaces, type PromptSurface } from "./prompt-surfaces";

// The generalisation of P.5 (2026-08-17).
//
// P.5 caught the pointer-events rule reaching only the BUILD contract while
// every occlusion it was written to prevent came from an EDIT. It caught it by
// luck — someone thought to check the second path. This file removes the luck:
// every rule about the finished GAME is asserted against every prompt that can
// write or rewrite one.
//
// The failure this guards is invisible by construction. The rule exists, a test
// asserts it exists, and the path that needed it never saw it — so the fix
// looks shipped, the suite is green, and the child's game is broken exactly as
// before. It has happened twice already (see prompt-surfaces.ts).
//
// HOW TO ADD A RULE: add it to ARTIFACT_INVARIANTS with the surfaces it must
// reach, and an `exempt` entry with a WRITTEN REASON for any surface it should
// not. There is no silent option. "I only put it in the build contract" is now
// a failing test rather than a discovery three weeks later.

interface Invariant {
  id: string;
  /** What goes wrong in a child's hands when a surface lacks this. */
  why: string;
  /** Must match the surface text. Kept loose enough to survive rewording,
   *  tight enough that unrelated prose cannot satisfy it — an early version of
   *  the control-intent tests passed on bare words like "sign" and "left"
   *  appearing elsewhere in a 15k-token prompt. */
  match: RegExp;
  /** Surfaces this rule does NOT apply to, each with the reason. */
  exempt?: Record<string, string>;
}

const ARTIFACT_INVARIANTS: Invariant[] = [
  {
    id: "controls-not-covered",
    why:
      "an invisible full-screen layer eats every tap. The buttons render, the " +
      "handlers are perfect, nothing throws and nothing is logged — the taps " +
      "just never arrive. This is the owner's 'the take off and land buttons " +
      "are not working', which survived four shipped fixes aimed at the handlers.",
    match: /pointer-events/i,
  },
  {
    id: "one-input-intent",
    why:
      "the keyboard and the on-screen button for one action drift to opposite " +
      "values, so UP descends. Both handlers fire correctly; they disagree " +
      "about which way is up. Owner: 'i am not able to move up or down'.",
    match: /one input intent|same variable|one shared intent/i,
  },
  {
    id: "draw-every-frame",
    why:
      "an early `return` above the draw call leaves the canvas blank behind " +
      "the start screen, so the child's first impression of their game is an " +
      "empty box.",
    match: /every frame|renderer\.render/i,
  },
];

const surfaces = artifactPromptSurfaces();
const byId = (id: string) => surfaces.find((s) => s.id === id)!;

describe("the surface registry itself", () => {
  it("S.1 lists every prompt that can produce or alter a delivered game", () => {
    // Enumerated from `grep 'await chatModel\.' src/app/api/*/route.ts` on
    // 2026-08-17. If a new model call can change a game, it belongs here — and
    // this assertion is what makes adding one a deliberate act.
    expect(surfaces.map((s) => s.id).sort()).toEqual([
      "build",
      "edit",
      "repair",
      "spec-compiler",
      "strict-edit-retry",
    ]);
  });

  it("S.2 every surface carries real prompt text, not an empty string", () => {
    // A surface that resolves to "" would satisfy nothing and fail everything,
    // or worse, be quietly skipped — assert it loudly instead.
    for (const s of surfaces) {
      expect(s.text.length, `${s.id} has no prompt text`).toBeGreaterThan(200);
    }
  });

  it("S.3 the strict-retry rung really does carry the build contract", () => {
    // It is composed as personaBasePrompt(persona) + the strict section, and
    // personaBasePrompt returns CHILD_SYSTEM_PROMPT. That is load-bearing: this
    // rung does 100% of repair work in production, so if it were the bare
    // strict section it would be a fourth uncovered surface.
    expect(byId("strict-edit-retry").text).toMatch(/SEARCH/);
    expect(byId("strict-edit-retry").text).toMatch(/friendly, encouraging assistant/i);
  });
});

describe("every artifact invariant reaches every surface that can break it", () => {
  for (const rule of ARTIFACT_INVARIANTS) {
    for (const surface of surfaces) {
      const exemption = rule.exempt?.[surface.id];
      const label = `${rule.id} → ${surface.id}`;

      if (exemption) {
        it(`${label} — EXEMPT: ${exemption}`, () => {
          // An exemption is a claim, so it is recorded as a passing test with
          // its reason in the name. It shows up in the run output next to the
          // rules that ARE enforced, which is the point: exemptions should be
          // visible, not buried in a config object nobody reads.
          expect(exemption.length).toBeGreaterThan(20);
        });
        continue;
      }

      it(label, () => {
        expect(
          surface.text,
          `\n\nThe "${rule.id}" rule does not reach the "${surface.id}" surface.\n` +
            `That surface: ${surface.what}\n` +
            `Without the rule: ${rule.why}\n` +
            `Either add the rule to that prompt, or add an \`exempt\` entry saying why it does not apply.\n`,
        ).toMatch(rule.match);
      });
    }
  }
});

describe("gated-off surfaces are held to the same standard", () => {
  it("S.4 a dormant surface is still checked, because flipping a flag is one line", () => {
    // The spec compiler is off today. Its §2 mandates a START SCREEN — the
    // exact instruction that introduced the occlusion bug when it landed in the
    // build contract without a pointer-events rule beside it. "It was gated
    // off" is no comfort to the child who gets the first broken game after the
    // flag flips, so dormant surfaces are not exempt from anything.
    const dormant = surfaces.filter((s) => s.gatedOff);
    expect(dormant.length).toBeGreaterThan(0);
    for (const s of dormant) {
      for (const rule of ARTIFACT_INVARIANTS) {
        if (rule.exempt?.[s.id]) continue;
        expect(s.text, `${s.id} is dormant but still missing ${rule.id}`).toMatch(rule.match);
      }
    }
  });
});

describe("a rule that mandates an overlay must name its escape in the same breath", () => {
  it("S.5 any surface requiring a START SCREEN also teaches pointer-events", () => {
    // The precise causal pair, pinned. Commit 9452e2c added "Show a START
    // SCREEN" to the build contract with no pointer-events rule anywhere in the
    // codebase; `start_occluded` had NEVER occurred before that day and then
    // hit 4 of 4 generations in one session. Telling a model to put a
    // full-screen layer over the game, without telling it how to make that
    // layer inert, is the bug — so the two instructions are now inseparable.
    const mandatesStartScreen = surfaces.filter((s: PromptSurface) => /START SCREEN/i.test(s.text));
    expect(mandatesStartScreen.length).toBeGreaterThan(0);
    for (const s of mandatesStartScreen) {
      expect(s.text, `${s.id} mandates a start screen but never mentions pointer-events`).toMatch(
        /pointer-events/i,
      );
    }
  });
});
