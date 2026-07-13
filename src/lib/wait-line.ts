// Escalating kid-facing wait status (owner decision 2026-07-13): a frozen
// "Thinking…" for minutes is bad UX for kids — the line must visibly breathe
// and stay honest about what's happening. Thresholds align with the server's
// stall-switch watchdog (~45s silence → next model). Pure function.

const STAGES: Array<{ afterMs: number; line: string | null }> = [
  { afterMs: 0, line: null }, // default "Thinking… 💭" is fine at first
  { afterMs: 12_000, line: "Big build in progress — stacking all the pieces! 🧱" },
  { afterMs: 30_000, line: "The robots are extra busy — calling in a faster helper! 🤖⚡" },
  { afterMs: 60_000, line: "Almost there — the helper is on it, hang tight! 🔧" },
  { afterMs: 120_000, line: "Still working — this one's a monster build! 🦖" },
];

/** The status line for how long the kid has been waiting; null = default. */
export function waitLine(elapsedMs: number): string | null {
  let line: string | null = null;
  for (const s of STAGES) if (elapsedMs >= s.afterMs) line = s.line;
  return line;
}
