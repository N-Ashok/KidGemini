// Copyable error report (owner request 2026-07-20). The console tab was
// hidden from kids during the self-healing preview work (PRD G1: a kid must
// never meet a stack trace) — but that ALSO removed the grown-up's only way
// to copy an error when a game breaks unexpectedly. This module decides when
// details are offered at all, and formats the report. Pure — no DOM, no React.
//
// Deliberately excludes the game's HTML: a report gets pasted into chats and
// tickets; it should carry the diagnosis, not the whole source file.

import type { GameConsoleMessage } from "@/types/game-console.types";
import type { VerifyOutcome } from "@/types/preview-verify.types";

/** Keeps a pasted report readable (and clipboard-safe) however hard a broken
 *  game loops on its own errors. */
export const MAX_REPORT_CHARS = 4_000;
const MAX_ERRORS = 10;
const MAX_STACK_LINES = 4;

/** Real errors only — console.log/warn chatter is not "something unexpected". */
function isHardError(m: GameConsoleMessage): boolean {
  return m.level === "error";
}

/**
 * Whether to offer the error-details affordance: the game actually threw, or
 * the verify/repair pass gave up. A healthy game never shows it, so a kid
 * playing a working game still never meets a console.
 */
export function hasExtremeError(input: {
  outcome: VerifyOutcome | null;
  errors: GameConsoleMessage[];
}): boolean {
  if (input.outcome === "failed" || input.outcome === "bailed") return true;
  return input.errors.some(isHardError);
}

export interface ErrorReportInput {
  gameTitle?: string;
  outcome: VerifyOutcome | null;
  /** Verify's failure code when it has one (load_error, resource_404…). */
  failureCode?: string | null;
  errors: GameConsoleMessage[];
  userAgent?: string;
  /** Caller-supplied timestamp (keeps this module pure/testable). */
  at?: string;
}

export function buildErrorReport(input: ErrorReportInput): string {
  const hard = input.errors.filter(isHardError);
  const lines: string[] = ["Ari — game error report"];
  if (input.gameTitle) lines.push(`Game: ${input.gameTitle}`);
  if (input.at) lines.push(`When: ${input.at}`);
  lines.push(`Check result: ${input.outcome ?? "unknown"}${input.failureCode ? ` (${input.failureCode})` : ""}`);

  if (hard.length === 0) {
    lines.push("", "The game reported no error messages — it failed the start-up check without throwing.");
  } else {
    lines.push("", `Errors (${hard.length}${hard.length > MAX_ERRORS ? `, showing first ${MAX_ERRORS}` : ""}):`);
    hard.slice(0, MAX_ERRORS).forEach((e, i) => {
      const where = e.filename ? ` [${e.filename}:${e.line ?? "?"}:${e.col ?? "?"}]` : "";
      lines.push(`${i + 1}. ${e.text}${where}`);
      if (e.url) lines.push(`   url: ${e.url}`);
      if (e.stack) {
        for (const s of e.stack.split("\n").slice(0, MAX_STACK_LINES)) {
          const t = s.trim();
          if (t) lines.push(`   ${t}`);
        }
      }
    });
  }

  if (input.userAgent) lines.push("", `Browser: ${input.userAgent}`);

  const out = lines.join("\n");
  return out.length > MAX_REPORT_CHARS ? `${out.slice(0, MAX_REPORT_CHARS - 3)}...` : out;
}
