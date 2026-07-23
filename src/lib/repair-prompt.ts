// Self-healing preview — §7 failure taxonomy → repair prompt, and the
// minimal-patch format (§7.1). Pure string/logic module, shared by the
// /api/repair route (build + apply) and the preview UI (kid-facing lines).
//
// The taxonomy IS the product: a vague "it's broken" gets a coin-flip
// rewrite; a precise failure gets a surgical patch that preserves the game
// the kid was already watching take shape.

import type { GameConsoleMessage } from "@/types/game-console.types";
import type { VerifyEvidence, VerifyFailureCode } from "@/types/preview-verify.types";

interface TaxonomyEntry {
  /** Repair instruction sent to Gemini, built from the concrete evidence. */
  instruction: (ctx: { evidence: VerifyEvidence | null; errors: GameConsoleMessage[] }) => string;
  /** §8.3 State-3 line — truthful, specific, kid-readable. */
  kidLine: string;
}

const firstError = (errors: GameConsoleMessage[]) =>
  errors.find((e) => e.kind === "error" || e.kind === "rejection");

export const REPAIR_TAXONOMY: Record<VerifyFailureCode, TaxonomyEntry> = {
  load_error: {
    instruction: ({ errors }) => {
      const e = firstError(errors);
      return `The game threw "${e?.text ?? "an uncaught error"}" at ${e?.filename ?? "?"}:${e?.line ?? "?"}.` +
        (e?.stack ? ` Stack:\n${e.stack}\n` : " ") + `Fix only that.`;
    },
    kidLine: "Something broke. Fixing it…",
  },
  async_loop: {
    instruction: ({ errors }) => {
      const e = firstError(errors);
      return `The game loop was wrapped in an async function (error: "${e?.text ?? ""}"). ` +
        `Per the platform contract, canvas layout, generateWorld(), startLevel() and gameLoop() ` +
        `must run immediately and synchronously on script load. Move them out of the async wrapper.`;
    },
    kidLine: "Getting the game started…",
  },
  resource_404: {
    instruction: ({ errors }) => {
      const r = errors.find((e) => e.kind === "resource");
      return `${r?.url ?? "A subresource"} failed to load. Replace it with a working, well-known ` +
        `public CDN URL — or inline the functionality so the game works offline.`;
    },
    kidLine: "One of the pieces didn't download. Getting it again…",
  },
  no_loop: {
    instruction: () =>
      `requestAnimationFrame was never called — the game loop never started. Make the game loop ` +
      `start immediately and synchronously on script load.`,
    kidLine: "The game isn't moving yet. Fixing…",
  },
  no_start_button: {
    instruction: () =>
      `No start control was found and the game loop is not running. Make the game loop start ` +
      `immediately on load (no start screen needed).`,
    kidLine: "The game isn't moving yet. Fixing…",
  },
  canvas_zero_size: {
    instruction: ({ evidence }) =>
      `The canvas bitmap is ${evidence?.canvas?.width ?? 0}×${evidence?.canvas?.height ?? 0} — nothing can paint. ` +
      `Set canvas.width and canvas.height in JavaScript from the container size, not only in CSS.`,
    kidLine: "The screen was the wrong size. Fixing…",
  },
  canvas_static: {
    instruction: () =>
      `The game loop runs but the canvas never repaints — the screen is frozen. Make the loop ` +
      `actually draw each frame.`,
    kidLine: "Nothing's drawing. Fixing…",
  },
  start_occluded: {
    instruction: ({ evidence }) => {
      const s = evidence?.start;
      return `The Start button at (${s?.x ?? "?"},${s?.y ?? "?"}) is covered by "${s?.occluder ?? "another element"}", ` +
        `so taps never reach it. Give that element pointer-events: none, or hide it when the game starts. ` +
        `Do NOT change the button's click handler — it works.`;
    },
    kidLine: "The Start button was hiding behind something. Fixing it…",
  },
  start_no_loop: {
    instruction: () =>
      `Clicking Start ran its handler, but requestAnimationFrame was still never called. The flag the ` +
      `handler sets is probably not the flag the loop checks — align them so Start actually starts the loop.`,
    kidLine: "Start wasn't starting anything. Fixing…",
  },
};

/** Second-attempt line (§8.3), then we stop. */
export const SECOND_ATTEMPT_LINE = "Still not quite right. One more try…";

/** §9.1 — repair exhausted: a question, never an apology + stack trace. */
export function exhaustedQuestion(): string {
  return "Hmm, that one didn't come out right. Tell me one thing to change — I'll rebuild it a different way!";
}

/** System prompt for the repair call — §7.1: minimal patch, never a rewrite. */
export const REPAIR_SYSTEM_PROMPT = `You wrote an HTML game for a child and an automated check found a problem.
Fix ONLY the reported problem — the child is watching this game take shape and must not lose it.
Return the fix as one or more blocks in EXACTLY this format, and nothing else:
<<<<<<< SEARCH
(lines copied EXACTLY, character for character, from the current source)
=======
(the replacement lines)
>>>>>>> REPLACE
Rules:
- The SEARCH text must match the current source exactly and uniquely.
- Make the smallest possible change. Do not rename, restyle, or "improve" anything else.
- No prose, no markdown fences, no full file.`;

/** The user content of a repair call. R.5: always carries the kid's original
 *  request so a fix never drifts from intent. */
export function buildRepairPrompt(input: {
  failureCode: VerifyFailureCode;
  evidence: VerifyEvidence | null;
  errors: GameConsoleMessage[];
  originalRequest: string;
  html: string;
}): string {
  const entry = REPAIR_TAXONOMY[input.failureCode];
  return [
    `Failure: ${input.failureCode}`,
    entry.instruction({ evidence: input.evidence, errors: input.errors }),
    ``,
    `The child originally asked for: "${input.originalRequest}"`,
    `Keep the game exactly what they asked for.`,
    ``,
    `Current source:`,
    input.html,
  ].join("\n");
}

const PATCH_RE = /<{7} SEARCH\r?\n([\s\S]*?)\r?\n={7}\r?\n([\s\S]*?)\r?\n>{7} REPLACE/g;

/** Leftover SEARCH/REPLACE conflict markers — the 7-angle-bracket sigils never
 *  appear in a real game, so their presence in a would-be full document means a
 *  half-applied patch leaked in (BUG-FIX-LOG 2026-07-23). */
const CONFLICT_MARKER_RE = /<{7} SEARCH|>{7} REPLACE/;

export type PatchResult =
  | { ok: true; html: string; mode: "patch" | "regeneration" }
  | { ok: false; reason: string };

/**
 * Applies the model's SEARCH/REPLACE blocks to the current source (R.6).
 * Falls back to a full-document reply (the slow path §7.1 warns about) so a
 * disobedient model still repairs rather than failing the attempt.
 */
export function applyPatch(html: string, reply: string): PatchResult {
  const blocks = [...reply.matchAll(PATCH_RE)];
  if (blocks.length > 0) {
    let out = html;
    for (const [, search, replace] of blocks) {
      const idx = out.indexOf(search!);
      if (idx === -1) return { ok: false, reason: "search_not_found" };
      if (out.indexOf(search!, idx + 1) !== -1) return { ok: false, reason: "search_ambiguous" };
      out = out.slice(0, idx) + replace! + out.slice(idx + search!.length);
    }
    return { ok: true, html: out, mode: "patch" };
  }

  // Fallback: model returned a whole file despite instructions.
  const fenced = reply.match(/```html\s*([\s\S]*?)```/i)?.[1];
  const full = fenced ?? (/<!doctype html|<html[\s>]/i.test(reply) ? reply : null);
  if (full?.trim()) {
    // A clean game NEVER contains SEARCH/REPLACE markers. BUG-FIX-LOG 2026-07-23:
    // the model wrapped a HALF-PATCHED document in a ```html fence, leaving raw
    // conflict markers inside; storing it verbatim shipped a corrupted game (the
    // edit never took, and the markers rendered in <style>). Reject it so the
    // caller escalates to a real full regeneration instead of saving garbage.
    if (CONFLICT_MARKER_RE.test(full)) return { ok: false, reason: "conflict_markers" };
    return { ok: true, html: full.trim(), mode: "regeneration" };
  }

  return { ok: false, reason: "no_patch_in_reply" };
}
