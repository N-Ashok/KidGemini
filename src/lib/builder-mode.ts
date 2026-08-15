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

/** The ways a child asks for 3D WITHOUT using the word "3D" (2026-08-15).
 *
 *  Owner: "when child is asking realistic, he is asking for 3D... we need to
 *  understand the intent from child, not verbatim." Measured before this
 *  existed: "make it realistic", "i want it to look real", "make it look like
 *  real life", "realistic graphics", "make it lifelike" and "a real looking
 *  car" ALL left the 3D catalog off, so the model never received the 3D
 *  playbook, the model library, AR_ASSETS or placeModel — and no amount of
 *  prompt wording could recover it, because the text that would teach it is
 *  exactly the text being withheld. Same class as the 2026-08-09 "3-D" miss,
 *  one rung more abstract.
 *
 *  DELIBERATELY WEAKER THAN THREE_ASK_RE, and used in exactly one place: the
 *  CATALOG gate. It does NOT make a message a build turn (a child saying "the
 *  film was realistic" is chatting, not commissioning), and it does NOT count
 *  as the explicit 3D ask that converts an existing 2D game — that still needs
 *  the literal word, because silently rebuilding a child's working 2D game in
 *  3D because they said "realistic" would be worse than the bug this fixes.
 *  Unlocking the catalog only ever means the model MAY use 3D. */
export const THREE_INTENT_RE =
  /\b(realistic|realistically|lifelike|life-?like)\b|\breal[\s-]?(life|world|looking)\b|\blooks?\s+real\b|\blook\s+like\s+real\b|\bnot\s+flat\b|\bsolid\s+(object|thing)s?\b/i;

/** Words that mean "do something to the game". Their PRESENCE is what keeps a
 *  request a build turn even when it is phrased as a question — "can you make
 *  the car red?" is a change, not a chat. */
const CHANGE_ASK_RE =
  /\b(add|added|adding|make|makes|making|change|changed|remove|delete|put|move|fix|fixed|build|create|turn\s+it|instead|another|more|again|faster|slower|bigger|smaller|higher|lower|harder|easier|colou?r|background|music|sound|score|level|speed|jump|start|restart|controls?)\b/i;

/** The shapes a child's message takes when they are TALKING to you rather than
 *  commissioning work: a question, a greeting, thanks, or a reaction. */
const PLAIN_CHAT_RE =
  /^\s*(hi|hey|hello|yo|thanks|thank\s+you|ty|bye|goodbye|good\s+(morning|night|evening)|lol|haha|cool|nice|wow|awesome|amazing|ok|okay|yes|no|i\s+love\s+(it|this)|that('?s| is)\s+(cool|nice|great|awesome))\b[\s!.]*$/i;
const QUESTION_RE =
  /^\s*(who|what|what'?s|why|how|when|where|which|whose|is|are|was|were|do|does|did|can|could|would|will|should|tell\s+me|explain)\b/i;

/** True when the message is plainly conversation, not a request to build or
 *  change anything (2026-08-15, KNOWN_BUGS #13).
 *
 *  Owner: "it used to answer kids on regular chat... when kids don't ask for a
 *  game, it don't reply. it still generates games." The cause is the artifact
 *  rule below: once a chat contains ANY game, every later message was a
 *  builder/edit turn regardless of what the child typed, so "why do stars
 *  twinkle?" arrived wrapped in a patch contract instead of being answered.
 *
 *  Deliberately CONSERVATIVE — it only fires on an unmistakable question or
 *  greeting that carries no change word at all. Anything ambiguous stays a
 *  build turn, because wrongly answering a real change request costs the child
 *  their edit, while wrongly building on a question merely wastes a turn. */
export function looksLikePlainChat(message: string): boolean {
  if (CHANGE_ASK_RE.test(message)) return false;
  if (PLAIN_CHAT_RE.test(message)) return true;
  return QUESTION_RE.test(message) || /\?\s*$/.test(message.trim());
}

export function isGameBuildTurn(message: string, history: ChatMessage[]): boolean {
  if (/\bgame\b/i.test(message)) return true;
  if (THREE_ASK_RE.test(message)) return true;
  // A question or a greeting is not a build turn just because a game happens
  // to exist earlier in the conversation — see looksLikePlainChat.
  if (looksLikePlainChat(message)) return false;
  return history.some((m) => Boolean(m.artifactHtml));
}

/** Builder-turn generation overrides, env-tunable (shape documented in
 *  .env.example). Junk values fall back to defaults — never NaN into the API. */
export function builderGenOverrides(env: Record<string, string | undefined>) {
  return {
    thinkingConfig: {
      thinkingBudget: positiveInt(env.GEMINI_BUILDER_THINKING_BUDGET, DEFAULT_THINKING_BUDGET),
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
