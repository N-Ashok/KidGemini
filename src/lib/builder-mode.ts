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
 *  never says "game" — the artifact in history is the signal). */
export function isGameBuildTurn(message: string, history: ChatMessage[]): boolean {
  if (/\bgame\b/i.test(message)) return true;
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
