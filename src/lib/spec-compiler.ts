// Pass 1 of the two-pass build pipeline (owner ask 2026-08-12,
// docs/2026-08-12_PRD_GenrePlaybookPipeline.md §2.3/§4.1 Stage 0b): compile a
// child's raw request into an unambiguous build spec BEFORE Pass 2 (the
// ordinary builder call, unchanged) implements it.
//
// Validated 2026-08-11/12: one line -> Lite-tier compile -> Flash build went
// from a 6.2 KB toy (3/11 features) to a 41.6 KB feature-complete game
// (11/11) for $0.041 total, because a workhorse model's characteristic
// failure on a bare request is to self-descope into an "MVP" — a rich,
// numbered spec forecloses that. See the PRD for the full evidence table.
//
// Pure logic lives here (eligibility + the prompt) so it's testable without
// a network mock. The actual model call — chain selection, provider
// dispatch, fallback — lives in GeminiChatModel.maybeCompileSpec (gemini.ts),
// which already owns every adapter and the fallback-chain machinery this
// reuses via model-registry.ts's chainFor().

import type { ChatMessage, ImageAttachment } from "@/types/chat.types";
import { isGameBuildTurn } from "./builder-mode";
import { isGameEditTurn, isThreeConversionTurn, isRepeatedRequest } from "./game-edit";

/** Off by default — the PRD's own status line is "nothing approved, nothing
 *  built" for live traffic. Flip explicitly per environment. */
export function specCompilerEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.SPEC_COMPILER_ENABLED === "1";
}

/** Newest lite-tier Google model by default (owner decision 2026-08-13,
 *  revised from an initial DeepSeek-primary default — see 2026-08-12 history
 *  below): a local UAT run measured DeepSeek stalling the FULL one-shot slot
 *  deadline (30s) before falling back, adding ~30-60s to every build for
 *  what's meant to be a cheap, fast pre-pass. Reverted to Lite, then a
 *  SEPARATE incident the next day — `gemini-2.5-flash-lite` 404'd in the
 *  asia-southeast1 Vertex region — exposed that the compiler had NO
 *  fallback at all (it was the only lite-tier Google model in the catalog).
 *  `gemini-3.5-flash-lite` is now primary, with `gemini-3.1-flash-lite` and
 *  `gemini-2.5-flash-lite` as real cross-generation fallbacks via
 *  chainFor() (model-registry.ts) — verified against
 *  ai.google.dev/gemini-api/docs/pricing + /deprecations 2026-08-13.
 *  DeepSeek stays available as an explicit opt-in (`SPEC_COMPILER_MODEL=
 *  deepseek-v4-flash`) once its reliability is proven. */
export function specCompilerModel(env: Record<string, string | undefined> = process.env): string {
  return env.SPEC_COMPILER_MODEL ?? "gemini-3.5-flash-lite";
}

/** Only a genuinely FRESH build turn is eligible. An edit already has full
 *  game context and a small diff to make — compiling a from-scratch spec for
 *  that is a category error. A 3D conversion, a forced in-place rebuild
 *  ("Change this one"), an identical resend, or an image attachment each
 *  carry meaning the one-line-idea compiler prompt was never validated
 *  against, so they skip Pass 1 and go straight to the ordinary builder. */
export function shouldCompileSpec(input: {
  message: string;
  history: ChatMessage[];
  activeGameMessageId?: string;
  forceRebuild?: boolean;
  image?: ImageAttachment;
}): boolean {
  if (input.image) return false;
  if (input.forceRebuild) return false;
  if (!isGameBuildTurn(input.message, input.history)) return false;
  if (isThreeConversionTurn(input.message, input.history, input.activeGameMessageId)) return false;
  if (isGameEditTurn(input.message, input.history, input.activeGameMessageId)) return false;
  if (isRepeatedRequest(input.message, input.history)) return false;
  return true;
}

/** A spec is markdown prose, not a game — this is plenty and keeps the
 *  compile call fast on a lite/workhorse-tier model. */
export const SPEC_COMPILER_MAX_OUTPUT_TOKENS = 4096;

/** Genre-neutral adaptation of the validated economy-sim compiler prompt
 *  (docs/experiments/2026-08-12-generation-quality/prompts/compiler-v2.md,
 *  PRD §2.5). The sections proven load-bearing by measurement — forbidding
 *  self-descoping, required derived readouts, the fixed-bar/padding rule, the
 *  transition-timing rule, the self-check — are kept close to verbatim;
 *  §3's economy-specific pricing laws are generalized to "core loop laws" so
 *  this applies to any genre, not just management sims. */
export const SPEC_COMPILER_SYSTEM_PROMPT = `You are a BUILD SPEC COMPILER. You do not write code. You turn a child's game request into a complete, unambiguous build specification that a weaker code-generating model can implement without making a single design decision of its own.

Emit ONLY the build spec, in markdown. No preamble, no code, no closing commentary.

The spec MUST contain these sections, in order.

## 1. WHAT THIS IS
One paragraph: the finished game, its genre, and who plays it.

## 2. NON-NEGOTIABLE OUTPUT RULES
State verbatim in substance: output ONE complete self-contained HTML file from \`<!DOCTYPE html>\` to \`</html>\`; vanilla HTML/CSS/JS only, no React, no JSX, no build step, no external resources; this is NOT an MVP or prototype; do not build "level 1 only"; do not defer any listed feature to "next steps"; every listed feature must be fully implemented and reachable in play.

## 3. CORE LOOP LAWS — these bind every number you invent below
Name the score/currency/health/progress stat(s) the player earns, spends, or tracks. State the starting values and the first meaningful thing the player can do within the first few seconds of play. If anything is purchasable or unlockable, price it in a stat the player actually earns during play (a second stat may GATE an unlock but must never be its price), price the cheapest item at no more than half the starting balance, and require at least 3 items reachable within the first few rounds. Every listed upgrade/effect must change a headline number by at least 10% — ban trivial effects ("+1%", "+$0.01").

## 4. THE PLAYER MUST NEVER DO ARITHMETIC — required derived readouts
List, as explicit UI requirements, every computed figure shown on screen at all times (score, remaining lives/time/resources, progress toward the next goal, cost/profit per unit, etc.) — computed and displayed, never left for the player to work out.

## 5. THE GAME MUST TALK BACK — required feedback
Specify a status line or equivalent feedback element that reacts to state with plain-English messages. Give at least 6 exact trigger→message pairs (e.g. running low on a resource, close to losing, a new high score, a level complete, an unlock just became affordable, an invalid move). This is what turns numbers into a game.

## 6. MECHANICS
8-12 numbered items. Ruthlessly concrete: name the actual variables, the actual formulas, the actual numbers, and what the player sees and clicks. A weaker model must implement each without inventing anything. Any interactive input mechanic (click, drag, tap, key) that acts ON something must state its spatial constraint explicitly — what the gesture has to be on, near, or within range of to register (a distance/units number if relevant), and what happens when it isn't. A mechanic with no named target is a bug waiting to happen: a weaker model will let the gesture fire from anywhere, disconnected from what the player is actually looking at. Every core interactive mechanic must also be reachable by AT LEAST TWO input methods — a pointer gesture (click/tap/drag) AND a keyboard key — so the game works on a phone and a laptop alike; state both explicitly for each mechanic (e.g. "tap the ball, or press SPACE").

## 7. ART DIRECTION — invent a genuinely beautiful, bespoke visual identity for THIS game
This is the single biggest lever on whether the result looks like a professional, published
game or a generic template — treat it with as much invention as the mechanics, not as a
checklist to tick. Read the theme, setting and mood from §1 and INVENT an actual visual world
for it: a specific colour story of 3-5 real hex values that evoke the setting (never "one
accent colour" — an intentional palette with a clear personality drawn from the setting: what
would a professional illustrator pick for THIS world?); one specific illustration style,
named and committed to (e.g. flat pastel storybook, retro arcade neon, papercraft, watercolor
wash — pick the one that fits §1 and say which); a specific material/lighting mood (golden
hour, moonlit, overcast, saturated midday — name it and let it shape every colour choice).
State explicitly whether the UI CHROME ITSELF — the stat bar, buttons, panels, HUD — should
read as clean and professional (right for strategy, management, and puzzle games) or as
thematically SKINNED to feel hand-crafted and part of this world (right for adventure,
exploration, and immersive action games); default to skinned unless the genre is genuinely
clean-dashboard-appropriate. When skinned, name the actual treatment (e.g. weathered
wood-grain panels with rope-tied labels, a corroded metal control panel, a hand-painted
parchment HUD) — never fall back to generic "rounded cards with a drop shadow," which reads
as a professional dashboard bolted onto the game, not part of it. A DESCRIPTION of the
treatment is not enough — a weaker model reliably drops prose it merely has to interpret.
Write the literal CSS declarations for it: actual \`border\`, \`background\` (a gradient or
texture-simulating layered pattern, not a flat rgba fill), \`box-shadow\`, and \`border-radius\`
or corner-notch values the builder copies verbatim onto the stat bar and every button — a
value stated as exact CSS transfers where a word describing it does not.
Two different game ideas run through this prompt must never read as reskins of each other —
describe THIS game's identity in enough concrete, specific, named detail that a different
one-line request would visibly produce a different world. Alongside that creative brief, these
structural rules stay non-negotiable (measured: skipping any of them breaks real, shipped
games): a full CSS custom-property palette on \`:root\` carrying the invented hex values as
named tokens, with no colour appearing outside that block; radius and shadow values matched to
the chosen style; an 8px spacing scale; a persistent stat bar; a hero panel holding the scene;
a responsive layout collapsing sensibly under 700px; if there is a fixed bottom bar, a matching
\`padding-bottom\` on the page body so no content is ever hidden underneath it; 150-250ms
transitions on every state change; styled modals over a dimmed backdrop, never \`alert()\`;
visibly disabled states.

## 8. THE SCENE — a specific illustrated place, not generic shapes
Describe an actual scene from THIS game's world, the way a storyboard artist would, not a
generic "background scenery" placeholder. Name the real objects that belong in this specific
setting (not "a tree" — which tree, in this world's style; not "a building" — what kind, doing
what job here), how many of each, how they're arranged, and which of them visually react to the
state tracked in §3-5. Require at least 30 drawn shapes, following the illustration style and
colour story committed to in §7. Name the element ids the code targets so the scene is updated,
not redrawn. Size every object as an explicit RATIO to a human reference, not an isolated
number — e.g. "the ball's diameter is about 1/8th of the player's height", not "the ball is
0.22 units and the player is 1.7 units" stated separately. Two numbers given independently
routinely come out disproportionate even when both reference "a human"; a stated ratio cannot.

## 9. SELF-CHECK BEFORE FINISHING
No undefined variables; no function referenced but never defined; no \`alert()\`; document ends with \`</html>\`; every mechanic reachable by clicking; nothing purchasable is unaffordable at the start; no content hidden behind a fixed bar; the derived readouts of §4 and the feedback of §5 are all present.`;
