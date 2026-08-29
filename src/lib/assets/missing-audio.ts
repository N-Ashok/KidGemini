// Missing-sound register (owner decision 2026-08-29).
//
// A generated game sometimes calls for a sound we do not own —
// `playMusic("bg_loop_adventure")`, `playSound("bump")`. Measured on 239
// production games: 4 of the 25 that have audio (16%) name at least one asset
// that does not exist. At runtime that is only a console.warn, so the game
// ships SILENT and every check we own passes it.
//
// The owner's decision, deliberately NOT a fallback sound: if we have nothing
// that fits, play nothing — a wrong sound is worse than none — but WRITE THE
// MISS DOWN, so the weekly review can turn real demand into new library
// assets. Nothing here is ever surfaced to a child; it is a server-side
// register only.
//
// Leaving the call in the game is intentional too: the day the asset lands in
// the manifest, every game that already asked for it starts working.

export interface MissingAudio {
  name: string;
  kind: "sfx" | "music";
}

/** `playSound("x")` / `playMusic('y')` / backticks. Skips our own runtime
 *  helper definitions (`window.playSound = function (name…`) — those are not a
 *  game asking for anything. */
const CALL_RE = /\bplay(Sound|Music)\s*\(\s*["'`]([A-Za-z0-9_]+)["'`]/g;

export function missingAudioNames(html: string, known: readonly string[]): MissingAudio[] {
  const have = new Set(known);
  const seen = new Set<string>();
  const out: MissingAudio[] = [];
  for (const m of html.matchAll(CALL_RE)) {
    const kind = m[1] === "Music" ? "music" : "sfx";
    const name = m[2]!;
    if (have.has(name) || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, kind });
  }
  return out;
}
