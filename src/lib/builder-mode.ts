// Middle-path thinking (owner decision 2026-07-09). Ordinary chat keeps
// thinkingBudget 0 — instant first token, chat-app feel. Game-BUILD turns get
// a bounded thinking budget and more output headroom: on the same Flash model,
// these two knobs are what make gemini.google.com's game code better than ours.
// Pure logic, no React/Next.

import type { ChatMessage } from "@/types/chat.types";

// 2048 → 1024 (owner decision 2026-07-11): vague asks burned the whole budget
// weighing interpretations before any code streamed. Paired with the
// commit-to-one-interpretation line in CHILD_SYSTEM_PROMPT; raise back via
// GEMINI_BUILDER_THINKING_BUDGET if game quality visibly drops.
const DEFAULT_THINKING_BUDGET = 1024; // bounded: ~5-10s worst-case silence
// Edit turns (2026-08-25 PRD_EditTurnCost §4.B): a SEARCH/REPLACE patch against
// a source the model reads verbatim needs far less deliberation than a fresh
// build. Probe (scripts/probe-thinking.mjs, 3.7-flash on Vertex, 3 reps):
// budgets 256–1024 → 0–154 thought tokens, 3/3 clean patches; an UNBOUNDED
// budget (-1 / unset) → 1,200–3,300 thoughts, 22–26s, and a dropped patch.
// The prod strict-retry rung already patches fine at a halved budget.
const DEFAULT_EDIT_THINKING_BUDGET = 512;
const DEFAULT_MAX_OUTPUT_TOKENS = 24576; // full games run 10-20K tokens; 8K squeezed them

/** A turn pays for thinking when the child asks for a game outright, or is
 *  iterating on one already in the conversation ("make the player jump higher"
 *  never says "game" — the artifact in history is the signal). A bare "3d …"
 *  phrase also counts: the Game Stuff gallery teaches exactly "3d cars" as
 *  the magic words (owner decision 2026-07-12), and on a game-builder product
 *  that phrase IS a game ask. */
/** The ways a child actually writes "3D". SHARED with the catalog gate
 *  (assets/catalog-gate.ts) — it used to be a second, separately-drifting copy
 *  of `/\b3d\b/i`, and BUG_LOG 2026-08-09 ("Calvin") turned on exactly that
 *  pattern being too narrow: "Make it 3-D" matched neither copy, so a literal
 *  3D request was built with none of the 3D house rules. One definition now,
 *  so the build-turn gate and the catalog gate can never disagree again.
 *
 *  The trailing `\b` after `d` keeps "3-day" out; requiring the digit form to
 *  end at `d` keeps "3ds max" out. */
export const THREE_ASK_RE = /\b3\s*-?\s*d\b|\b3\s*-?\s*dimensional\b|\bthree[\s-]?dimensional\b/i;

/** 2026-08-27 (owner): a child rarely says "3D" — they say what they SEE.
 *  "realistic", "real life", "lifelike", "better/real/good graphics",
 *  "look(s) real", "more real". These are the kid-words for the same ask.
 *  Deliberately NOT matched: "really", "real names", "is that real?" (a
 *  question, not a look), "graph". */
export const THREE_QUALITY_RE =
  /\brealistic\b|\breal[\s-]?life\b|\blife[\s-]?like\b|\b(better|real|good|cool|amazing|awesome)\s+graphics\b|\b(looks?|looking|feel|feels|more)\s+real\b/i;

/** The single "this child wants 3D" definition — literal 3D words OR the
 *  quality words above. Shared by the catalog gate (assets/catalog-gate.ts)
 *  and the 2D→3D conversion predicate (game-edit.ts) so they never disagree. */
export const THREE_WANT_RE = new RegExp(`${THREE_ASK_RE.source}|${THREE_QUALITY_RE.source}`, "i");

export function isGameBuildTurn(message: string, history: ChatMessage[]): boolean {
  if (/\bgame\b/i.test(message)) return true;
  if (THREE_ASK_RE.test(message)) return true;
  return history.some((m) => Boolean(m.artifactHtml));
}

/** Builder-turn generation overrides, env-tunable (shape documented in
 *  .env.example). Junk values fall back to defaults — never NaN into the API. */
export function builderGenOverrides(env: Record<string, string | undefined>, opts: { isEdit?: boolean } = {}) {
  const thinkingBudget = opts.isEdit
    ? positiveInt(env.GEMINI_EDIT_THINKING_BUDGET, DEFAULT_EDIT_THINKING_BUDGET)
    : positiveInt(env.GEMINI_BUILDER_THINKING_BUDGET, DEFAULT_THINKING_BUDGET);
  return {
    thinkingConfig: {
      thinkingBudget,
      // Thought summaries stream back as parts flagged `thought: true` — the
      // route turns them into the kid-facing planning line (kid-thought.ts)
      // so the thinking phase isn't a silent "Thinking…" stare (2026-07-11).
      includeThoughts: true,
    },
    maxOutputTokens: positiveInt(env.GEMINI_BUILDER_MAX_OUTPUT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS),
  };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
