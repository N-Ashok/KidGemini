// Every prompt surface that can produce or alter a game a child ends up playing.
//
// WHY THIS FILE EXISTS (2026-08-17, owner: "what will fail that we corrected in
// the last 2 days ... like the cartoonish items").
//
// A rule about the finished GAME — "nothing may cover the controls", "up must
// move it up", "draw every frame" — is only true if it reaches every prompt
// that can write or rewrite that game. There is more than one, and the number
// grows: build contract, the slimmed edit contract, the strict-retry rung, the
// repair contract, and (gated off) the spec compiler.
//
// This has already cost us twice:
//
//  - `pointer-events` was added to GAME_BUILD_CONTRACT and looked correct. Four
//    of four occlusions in the owner's session came from EDIT turns, which get
//    GAME_EDIT_CONTRACT instead — so the fix reached none of them. Caught only
//    because one test (P.5) happened to check the edit path.
//  - `SPEC_COMPILER_SYSTEM_PROMPT` §2 mandates a START SCREEN and says nothing
//    about pointer-events — the exact pairing that caused the bug. It is gated
//    off today; switching it on would reintroduce the fault at scale, silently,
//    with every existing test green.
//
// The failure mode is always the same and always invisible: the rule EXISTS, a
// test asserts it EXISTS, and the path that actually needed it never saw it.
// So the surfaces are enumerated here, once, and prompt-surfaces.test.ts asserts
// every artifact invariant against every one of them. Adding a surface without
// deciding what it must carry now fails a test instead of shipping.

import { buildTurnSystemInstruction, CHILD_SYSTEM_PROMPT } from "./gemini";
import { GAME_EDIT_STRICT_RETRY_SECTION as STRICT_RETRY_SECTION } from "./game-edit";
import { REPAIR_SYSTEM_PROMPT } from "./repair-prompt";
import { SPEC_COMPILER_SYSTEM_PROMPT } from "./spec-compiler";

/** What a surface hands back, which decides which rules can even apply to it. */
export type SurfaceProduces =
  /** A complete HTML document — every artifact rule applies. */
  | "whole-game"
  /** SEARCH/REPLACE blocks against an existing game. Rules still apply to what
   *  it ADDS or MOVES: a patch is how an overlay gets added over the controls,
   *  and how a render call ends up below an early return. */
  | "patch"
  /** Not code at all — a build spec another model implements. Rules apply
   *  because whatever the spec omits, the implementing model never hears. */
  | "spec";

export interface PromptSurface {
  id: string;
  /** Where this runs, in one line — so a reader knows what breaks if it drifts. */
  what: string;
  produces: SurfaceProduces;
  /** True when this surface is behind a flag and not currently live. It is
   *  still checked: a dormant surface that is wrong is a trap for whoever
   *  turns it on, and "it was off" is no comfort to the child who gets the
   *  first broken game after the flag flips. */
  gatedOff?: boolean;
  text: string;
}

/**
 * Every surface, in the order a turn can reach them.
 *
 * Deliberately built by CALLING the real prompt builders rather than by
 * re-declaring strings: a surface that changes shape must change here too, or
 * the tests are asserting against a copy nobody serves.
 */
export function artifactPromptSurfaces(): PromptSurface[] {
  const gates = { three: true, audio: true, save: true } as const;
  return [
    {
      id: "build",
      what: "a fresh game build — api/chat, replyStream/reply with isEdit=false",
      produces: "whole-game",
      text: buildTurnSystemInstruction(gates, true, /* isEdit */ false),
    },
    {
      id: "edit",
      what: "an edit turn — api/chat, the slimmed GAME_EDIT_CONTRACT",
      produces: "patch",
      text: buildTurnSystemInstruction(gates, true, /* isEdit */ true),
    },
    {
      id: "strict-edit-retry",
      what:
        "the strict SEARCH/REPLACE rung — three call sites: the edit retry, " +
        "the cheap rung before rebuild, and api/repair's rescue (which does " +
        "100% of repair work in production)",
      produces: "patch",
      // gemini.ts composes personaBasePrompt(persona) + the strict section, and
      // personaBasePrompt is CHILD_SYSTEM_PROMPT — so this surface really does
      // carry the whole build contract. Composed the same way here.
      text: `${CHILD_SYSTEM_PROMPT}\n\n${STRICT_RETRY_SECTION}`,
    },
    {
      id: "repair",
      what: "api/repair's first attempt — the self-heal, applied to a game the child is watching",
      produces: "patch",
      text: REPAIR_SYSTEM_PROMPT,
    },
    {
      id: "spec-compiler",
      what: "pass 1 of two-pass generation — writes the spec a weaker model implements verbatim",
      produces: "spec",
      gatedOff: true,
      text: SPEC_COMPILER_SYSTEM_PROMPT,
    },
  ];
}
