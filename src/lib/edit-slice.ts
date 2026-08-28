// Landmark slicing for edit turns — EXPERIMENT (2026-08-27, owner ask; see
// docs/2026-08-27_EXPERIMENT_EditSlicing.md). Off unless EDIT_SLICE=on.
//
// The build prompt makes every game carry short landmark comments above each
// logical part (`// --- PLAYER MOVEMENT ---`, `<!-- SCORING -->`). An edit
// prompt today sends the WHOLE game (~18k of ~22k prompt tokens). Most asks
// touch 2–3 sections. So: split the model view on its landmarks, show the
// sections the ask plausibly touches (plus the preamble — <head>, state
// variables), and collapse the rest to their landmark line + a placeholder.
//
// Safety: shown text is verbatim, so SEARCH/REPLACE hunks copied from the
// slice apply to the full document unchanged. If the model needs a hidden
// section its hunk misses (search_not_found) and the existing strict retry
// re-sends the FULL source — quality can never drop below the un-sliced path,
// only cost a wasted attempt. When in doubt (no landmarks, no keyword match)
// we send everything.
//
// Scale ceiling: keyword scoring is crude on purpose (no model call). If the
// miss rate measured by the experiment is high, the next step is a lite-model
// section picker, not smarter regexes.

import { gameUsesThree } from "./game-edit";

export interface LandmarkSection {
  title: string;
  /** The one-line "what this part does" the BUILD wrote after the colon
   *  (2026-08-28). "" for games built before that — they still slice, just
   *  from title + body alone. */
  summary: string;
  /** Verbatim text from the landmark line to just before the next landmark. */
  text: string;
  /** "js" (// --- X --- or /* --- X --- *​/) or "html" (<!-- X -->). */
  style: "js" | "html";
  lines: number;
}

export interface SliceResult {
  source: string;
  sliced: boolean;
  shown: string[];
  hidden: string[];
  fullChars: number;
  slicedChars: number;
}

// Matches `// --- NAME ---`, `// --- NAME: summary ---`, `<!-- NAME: summary -->`
// and the /* */ form. The captured text is split on the FIRST colon into
// title + summary, so bare landmarks (every game built before 2026-08-28)
// still parse with an empty summary.
const LANDMARK_LINE = /^[ \t]*(?:\/\/[ \t]*-{2,}[ \t]*([^\n]{2,160}?)[ \t]*-{2,}|<!--[ \t]*([^\n]{2,160}?)[ \t]*-->|\/\*[ \t]*-{2,}[ \t]*([^\n]{2,160}?)[ \t]*-{2,}[ \t]*\*\/)[ \t]*$/;

function splitLandmark(raw: string): { title: string; summary: string } {
  const at = raw.indexOf(":");
  if (at < 0) return { title: raw.trim(), summary: "" };
  return { title: raw.slice(0, at).trim(), summary: raw.slice(at + 1).trim() };
}
const MIN_LANDMARKS = 4;
/** Never show less than this share of the file — below it the model lacks context. */
const MIN_SHOWN_SHARE = 0.25;
/** Only slice when it actually saves something — placeholders cost bytes too. */
const MIN_SAVING = 0.2;
const STOP = new Set(["the", "and", "make", "add", "can", "you", "please", "with", "for", "when", "that", "this", "its", "it's", "into", "more", "less", "some", "game", "let", "have", "get", "put", "then", "also", "very", "like", "want", "should", "would"]);
/** Kid-word → code-word hints. Small on purpose. */
const SYNONYMS: Record<string, string[]> = {
  colour: ["color", "fill", "style"], color: ["fill", "style", "color"], red: ["color", "fill"], blue: ["color", "fill"], green: ["color", "fill"],
  faster: ["speed", "velocity", "spawn"], fast: ["speed"], slower: ["speed", "velocity"], slow: ["speed"], speed: ["velocity"],
  bigger: ["size", "scale", "width", "height", "radius"], big: ["size", "scale"], smaller: ["size", "scale"], small: ["size", "scale"],
  jump: ["gravity", "jump", "velocity"], hearts: ["lives", "health", "heart"], heart: ["lives", "health"], lives: ["hearts", "health"],
  points: ["score"], score: ["points", "score"], enemy: ["enemies", "spawn", "obstacle"], enemies: ["enemy", "spawn", "obstacle"],
  boss: ["enemy", "level", "spawn"], level: ["levels", "stage", "difficulty"], levels: ["level", "stage"],
  sound: ["audio", "sound", "play"], music: ["audio", "sound"], button: ["pointerdown", "touchstart", "onclick", "click"],
  over: ["gameover", "game over", "restart", "lose"], lose: ["gameover", "hearts", "lives"], win: ["win", "finish", "goal"],
  restart: ["reset", "play again", "gameover"], background: ["sky", "backdrop", "canvas", "body"], sky: ["background", "scene"],
};

function words(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9']+/).filter((w) => w.length >= 3 && !STOP.has(w));
}

export function parseLandmarkSections(source: string): { preamble: string; sections: LandmarkSection[] } {
  const lines = source.split("\n");
  const starts: { idx: number; title: string; summary: string; style: "js" | "html" }[] = [];
  lines.forEach((line, i) => {
    const m = LANDMARK_LINE.exec(line);
    if (m) starts.push({ idx: i, ...splitLandmark(m[1] ?? m[2] ?? m[3] ?? ""), style: m[2] !== undefined ? "html" : "js" });
  });
  if (starts.length === 0) return { preamble: source, sections: [] };
  const join = (from: number, to: number, last: boolean) => lines.slice(from, to).join("\n") + (last ? "" : "\n");
  const first = starts[0]!;
  const preamble = first.idx === 0 ? "" : join(0, first.idx, false);
  const sections = starts.map((s, k) => {
    const end = k + 1 < starts.length ? starts[k + 1]!.idx : lines.length;
    const last = k + 1 === starts.length;
    return { title: s.title, summary: s.summary, text: join(s.idx, end, last), style: s.style, lines: end - s.idx };
  });
  return { preamble, sections };
}

/** Sections holding the shared state an edit almost always needs to read:
 *  variables, config, the LEVELS array. Always shown. Replaces an earlier
 *  "always show the first section" rule, which was wrong on real games —
 *  section 0 is usually STYLING (measured on a real generated game,
 *  2026-08-28), not state. */
// TITLE only, and near-exact: matching the SUMMARY caught ordinary English
// ("setting up the sky", "leveling up") in 7 of 12 sections on a real game.
const STATE_SECTION_RE = /^(the |game |global )?(state|variables?|globals?|constants?|config|configuration|settings?|data|levels?)( (and|&) (state|variables?|data|config|settings?|levels?))?$/i;

function isStateSection(sec: LandmarkSection): boolean {
  return STATE_SECTION_RE.test(sec.title.trim());
}

/** Does this game carry the 2026-08-28 summaries? Games built before that
 *  have bare landmarks, so label-only matching would find nothing and they
 *  would never slice — they keep the older body-matching behaviour. */
function hasSummaries(sections: LandmarkSection[]): boolean {
  return sections.filter((s) => s.summary.length > 0).length * 2 >= sections.length;
}

function scoreSection(askWords: Set<string>, sec: LandmarkSection, labelsOnly: boolean): number {
  const title = sec.title.toLowerCase();
  // The build's own one-line description of the section — the most reliable
  // signal there is, because it is written in the same plain words a child
  // uses ("floating platforms", "play again button") rather than in code
  // identifiers. Weighted like the title.
  const summary = sec.summary.toLowerCase();
  // The landmark line itself is part of sec.text; strip it so a body match
  // can't double-count the title/summary words.
  const body = sec.text.slice(sec.text.indexOf("\n") + 1).toLowerCase();
  // Selection is driven by the LABELS the build wrote, not by grepping the
  // code. Measured 2026-08-28 on a real game: body matching made "make the
  // buttons bigger" match `width`/`height` in eight sections, which
  // over-selected until the saving guard gave up and sent the whole file.
  // The body now only breaks ties between label matches.
  let score = 0;
  for (const w of askWords) {
    const hints = [w, ...(SYNONYMS[w] ?? [])];
    if (hints.some((h) => title.includes(h) || summary.includes(h))) score += 3;
  }
  // With summaries present the labels decide, and the body is only a tiebreak
  // between sections the labels already matched — grepping the code made
  // "make the buttons bigger" match width/height in eight sections. Without
  // summaries (games built before 2026-08-28) the body is all there is.
  if (labelsOnly && score === 0) return 0;
  for (const w of askWords) {
    const hints = [w, ...(SYNONYMS[w] ?? [])];
    if (hints.some((h) => body.includes(h))) score += 1;
  }
  return score;
}

function placeholder(sec: LandmarkSection): string {
  const landmark = sec.text.split("\n")[0]!;
  const note = `hidden: ${sec.lines - 1} unchanged lines not shown this turn`;
  return `${landmark}\n${sec.style === "html" ? `<!-- … ${note} … -->` : `/* … ${note} … */`}\n`;
}

const SLICE_NOTE = "/* Ari: this is the whole game, but parts you don't need for THIS change are collapsed to their landmark line — which names the part and says what it does — plus a 'hidden' note. Every hidden part still exists, unchanged. Edit only code you can actually see, and never re-create a hidden part. */\n";

/** Which landmark sections an ask plausibly touches (titles). Empty = no
 *  opinion → the caller sends everything. Exported for tests + the experiment. */
export function pickSections(source: string, ask: string): string[] {
  const { preamble, sections } = parseLandmarkSections(source);
  if (sections.length < MIN_LANDMARKS) return [];
  const askWords = new Set(words(ask));
  const labelsOnly = hasSummaries(sections);
  const scored = sections.map((s, i) => ({ i, s, score: scoreSection(askWords, s, labelsOnly) }));
  // Shared state (variables / config / LEVELS) is always shown — an edit that
  // cannot see the declarations cannot change them.
  const show = new Set<number>(scored.filter((x) => isStateSection(x.s)).map((x) => x.i));
  const hits = scored.filter((x) => x.score > 0 && !show.has(x.i));
  if (hits.length === 0) return [];
  for (const h of hits) show.add(h.i);
  // Floor: never show less than a quarter of the file — add next-best sections until we do.
  const shownChars = () => preamble.length + [...show].reduce((n, i) => n + sections[i]!.text.length, 0);
  const rest = scored.filter((x) => !show.has(x.i)).sort((a, b) => b.score - a.score || a.i - b.i);
  while (shownChars() < source.length * MIN_SHOWN_SHARE && rest.length) show.add(rest.shift()!.i);
  return sections.filter((_, i) => show.has(i)).map((s) => s.title);
}

export function sliceEditSource(source: string, ask: string): SliceResult {
  // 2D ONLY (owner decision 2026-08-28). The 3D run broke a game: the picker
  // hid INITIALIZATION for "change the sky to night", the model could not see
  // init(), rewrote it, and shipped a duplicate declaration that crashes. A
  // 3D game also gains least — its source is only ~46% of the edit prompt,
  // the 3D playbooks are the rest. Checked HERE rather than at the call site
  // so nothing can opt a 3D game back in, and via game-edit.ts's
  // gameUsesThree so this can never disagree with billing or the 2D→3D
  // conversion about what "a 3D game" is.
  const whole = { source, sliced: false, shown: [] as string[], hidden: [] as string[], fullChars: source.length, slicedChars: source.length };
  if (gameUsesThree(source)) return whole;
  const { preamble, sections } = parseLandmarkSections(source);
  const picked = new Set(pickSections(source, ask));
  if (picked.size === 0 || picked.size === sections.length) return whole;
  const show = new Set(sections.map((s, i) => (picked.has(s.title) ? i : -1)).filter((i) => i >= 0));
  const out = SLICE_NOTE + preamble + sections.map((s, i) => (show.has(i) ? s.text : placeholder(s))).join("");
  if (out.length > source.length * (1 - MIN_SAVING)) return whole;
  return {
    source: out, sliced: true,
    shown: sections.filter((_, i) => show.has(i)).map((s) => s.title),
    hidden: sections.filter((_, i) => !show.has(i)).map((s) => s.title),
    fullChars: source.length, slicedChars: out.length,
  };
}

export function editSliceEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.EDIT_SLICE === "on";
}
