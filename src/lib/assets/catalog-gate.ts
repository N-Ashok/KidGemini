// Tier/keyword catalog gate (PRD-3D-GAMES-AND-ASSETS §9). Decides which
// prompt catalogs a turn carries. Nested under the build-turn gate so
// chit-chat pays zero catalog tokens (TECH_DEBT #33); 3D and audio gate
// independently (a 2D "platformer with sound" gets SFX, no 3D). Cheap
// regexes only — no LLM call, no I/O. Pure logic, no React/Next.

import type { ChatMessage } from "@/types/chat.types";
import { isGameBuildTurn, THREE_WANT_RE } from "../builder-mode";
import { GENRES } from "./model-select";
import { modelsInGenre, TAXONOMY, type GenreId } from "./asset-taxonomy";

/** WHY the 3D catalog is unlocked — it decides which lead-in the prompt gets,
 *  and that distinction is load-bearing (2026-08-23). THREE_PROMPT_SECTION
 *  opens "this child asked for 3D — so build a REAL 3D scene", which is true
 *  only when they did. Handing that same sentence to a subject-only unlock
 *  would build a spelling quiz in Three.js. `subject` gets a lead-in that
 *  OFFERS 3D and names the models; `asked` keeps today's wording byte-for-byte.
 *  Both are static text, so each keeps its own Gemini prefix-cache entry. */
export type ThreeUnlockReason = "asked" | "subject";

export interface CatalogGates {
  three: boolean; // engine + model catalog (they travel together: models need the engine)
  /** Set only when `three` is true. Absent means "asked" (the pre-2026-08-23
   *  shape), so every hand-written CatalogGates literal in the tests and the
   *  default in buildTurnSystemInstruction still produce the exact prompt they
   *  did before this field existed. */
  threeReason?: ThreeUnlockReason;
  audio: boolean; // sfx + music catalog (works in 2D games — no engine implied)
  // Save & continue building clause (docs/2026-08-01_PRD_SaveContinueBuilding.md
  // §3a). Optional — not every CatalogGates literal in this codebase's tests
  // was written with save-awareness, and undefined behaves as false (falsy),
  // same as omitting three/audio would if they were optional. New call sites
  // should set it explicitly; catalogGates() itself always returns it.
  save?: boolean;
  /** The sports playbook (rules + team AI, ~1,000 tokens) — set only when
   *  `three` is on AND the game is a sports game (2026-08-25: it used to ride
   *  every 3D turn because the MANIFEST holds sports models). Absent = off. */
  sports?: boolean;
}

// Free-tier triggers (§9): err toward unlocking — a false unlock costs a few
// catalog tokens; an under-unlock is a kid asking for sound and getting
// silence. Word-bounded so "grade3d" / "musical" don't fire.
//
// BUG_LOG 2026-08-09 ("Calvin"): this was `/\b3d\b/i`, which does not match
// "3-D". A child ended his ask with "Make it 3-D" and the 3D catalog was
// withheld from a turn that was literally a 3D request — so the model built in
// 3D having been told NONE of the house rules and used the open internet's
// default, a cdnjs <script> tag pulling three r128. That version predates
// CapsuleGeometry, so his game threw on the first shape it drew.
//
// The §9 principle ("err toward unlocking") was already the right call; the
// pattern just didn't implement it. It now lives in ONE place — builder-mode's
// THREE_ASK_RE — because this was a second copy of the same rule and the two
// could drift apart (they had).
// 2026-08-27 (owner): the trigger is THREE_WANT_RE — literal "3D" OR the
// kid-words for it ("realistic", "real life", "better graphics").
const THREE_TRIGGER = THREE_WANT_RE;

/** 2026-08-27 (owner decision): a child's FIRST game is 2D. The subject
 *  unlock below (2026-08-23) is OFF by default and kept behind
 *  THREE_SUBJECT_UNLOCK=on as the documented fallback (rule 11) — flip it if
 *  2D-first turns out to be wrong for the demo-style asks it was built for. */
function subjectUnlockEnabled(): boolean {
  return process.env.THREE_SUBJECT_UNLOCK === "on";
}

// ── The subject unlock (owner decision 2026-08-23) ────────────────────────
//
// THREE_TRIGGER above is the literal string "3D" and nothing else. That is a
// gate on the child's VOCABULARY, not on what they asked for — and a child
// asking to ride a horse never says "3D". BUG-FIX-LOG 2026-08-23: "make a game
// where I can ride horses" was built with this catalog OFF, so the rigged
// `horse` (121 KB, gallop clip, tagged pony/riding) was invisible to the turn
// and the only horse left to make was ctx.fillRect — a body rectangle, stroked
// legs, a dot eye. The owner's words: "it looks like a block diagram."
//
// So a SUBJECT unlocks it too. Composed from GENRES rather than a fresh word
// list, because the genres ARE the question being asked — "does the library
// hold physical things for this game?" — and a hand-written second list is the
// exact drift that put two copies of the 3D regex in this repo (see above).
//
// Which genres, and why not all of them:
//   · IN  — genres that own physical models: a creature, a vehicle, a place.
//   · OUT `platformer` — its words (platform/jump/collect/coins/maze/runner)
//     name how a game PLAYS, not what is in it, so they cannot tell us a model
//     would help. It also keeps the plain 2D platformer, a good product,
//     exactly as it is.
//   · OUT `people` — over-broad on its own words (man/women/kids/walking/
//     sitting) and would fire on a quiz.
//   · OUT `food`, `indian_games` — carrom, ludo, dice, marbles and a cooking
//     quiz are genuinely better flat.
// A genre added to the taxonomy later is OUT until it is named here on
// purpose. That is deliberate: an unlock is a prompt-shape change.
const THREE_SUBJECT_GENRES: ReadonlySet<GenreId> = new Set<GenreId>([
  "animals", "racing", "space", "snow", "castle", "city", "nature", "water", "sports", "military",
]);
const THREE_SUBJECT_TRIGGERS: readonly RegExp[] = GENRES.filter((g) => THREE_SUBJECT_GENRES.has(g.id)).map((g) => g.trigger);

/** Does this text name something the 3D library actually holds a model of? */
export function subjectSuggestsThree(text: string): boolean {
  return THREE_SUBJECT_TRIGGERS.some((re) => re.test(text));
}
const AUDIO_TRIGGER = /\b(sounds?|music|songs?|sfx)\b/i;
// Build/world/inventory mechanics (docs/2026-08-01_PRD_SaveContinueBuilding.md):
// a kid naming placement/persistence mechanics, not just "make me a game".
const SAVE_TRIGGER = /\b(build|building|stack|stacking|place|placing|placed|inventory|world|city|base)\b/i;
// Sports = the sports genre's own trigger (model-select.ts — football/cricket/
// beyblade words), or a game that already loads a sports model.
const SPORTS_TRIGGER = GENRES.find((g) => g.id === "sports")!.trigger;
const SPORTS_MODEL_NAMES = modelsInGenre("sports", new Set(Object.keys(TAXONOMY)));
const SPORTS_ARTIFACT = new RegExp(`(?:loadModel|placeModel)\\(\\s*["'](?:${SPORTS_MODEL_NAMES.join("|")})["']`);

/** What an EDIT turn's ask re-introduces (2026-08-25, plan noble-orbiting-stallman
 *  step 2/3). On an edit the instruction is slim — safety core, edit craft, a 3D
 *  cheat sheet — and a full playbook comes back ONLY when the ask itself names
 *  that subsystem. Evaluated on the ask alone (not the history): the history
 *  gates are monotonic build gates, and "build me a race track" unlocking
 *  ~870 tokens of save playbook on every later edit is exactly the waste. */
export interface EditGates {
  audio?: boolean;
  models?: boolean;
  physics?: boolean;
  sports?: boolean;
  save?: boolean;
  multiplayer?: boolean;
}
const EDIT_SAVE_TRIGGER = /\b(save|saving|saved|progress|continue|resume|checkpoints?|remember|load my)\b/i;
const EDIT_PHYSICS_TRIGGER = /\b(physics|gravity|bounc(e|y|ing)|collid(e|es|ing)|collision|fall(s|ing)?|throw(s|ing)?|jump(s|ing)?|heav(y|ier)|weight|friction|momentum)\b/i;
const EDIT_MULTIPLAYER_TRIGGER = /\b(multiplayer|(2|two)[- ]?player|co-?op|with (a|my) friend|versus|vs\.?|play together)\b/i;
export function editGates(message: string): EditGates {
  const out: EditGates = {};
  if (AUDIO_TRIGGER.test(message)) out.audio = true;
  const sports = SPORTS_TRIGGER.test(message);
  if (sports || subjectSuggestsThree(message) || GENRES.some((g) => g.trigger.test(message))) out.models = true;
  if (sports) out.sports = true;
  if (EDIT_PHYSICS_TRIGGER.test(message)) out.physics = true;
  if (EDIT_SAVE_TRIGGER.test(message)) out.save = true;
  if (EDIT_MULTIPLAYER_TRIGGER.test(message)) out.multiplayer = true;
  return out;
}

// Iteration insurance: a game already built WITH library assets keeps its
// catalogs on follow-up turns even when the keyword text has scrolled away.
// Markers first — but ALSO the game's structure (an import from "three", the
// importmap entry, loadModel/playSound calls): a generation that forgot its
// marker otherwise iterated with the catalog OFF, and the untaught model
// imported three names outside the curated bundle, killing the whole game on
// its import line (BUG-FIX-LOG 2026-07-20 "DoubleSide"). Err toward
// unlocking, per §9.
const THREE_ARTIFACT = /USES_THREE|USES_MODELS|from\s*['"]three['"]|['"]three['"]\s*:|loadModel\s*\(/;
const AUDIO_ARTIFACT = /USES_AUDIO|playSound\s*\(|playMusic\s*\(/;
// A game that already implements (or has started implementing) the save
// contract keeps the clause on follow-up turns — same "structural evidence"
// idiom as THREE_ARTIFACT, checking the postMessage protocol strings too so a
// generation that emitted the handlers but forgot the marker isn't punished.
const SAVE_ARTIFACT = /SUPPORTS_SAVE|ariantra:request-save|ariantra:save-state|__ARIANTRA_INITIAL_STATE__/;

/** The §9 decision tree: build turn? → paid: both · free: keyword scan over
 *  the message AND the child's prior messages AND prior artifacts. Paid is
 *  hardwired false at the call site until entitlement lands (TECH_DEBT #11) —
 *  then the caller passes the real entitlement and paid goes always-on.
 *  `save` follows the SAME free-tier keyword/artifact shape as three/audio —
 *  it is NOT part of the paid bundle (a build/world game is identified by
 *  what it IS, not by the child's plan), so paid:true does not force it on. */
export function catalogGates(input: { message: string; history: ChatMessage[]; paid: boolean }): CatalogGates {
  if (!isGameBuildTurn(input.message, input.history)) return { three: false, audio: false, save: false };

  const texts = [input.message, ...input.history.filter((m) => m.role === "child").map((m) => m.text)];
  const artifacts = input.history.map((m) => m.artifactHtml).filter((h): h is string => Boolean(h));
  const save = texts.some((t) => SAVE_TRIGGER.test(t)) || artifacts.some((h) => SAVE_ARTIFACT.test(h));
  const sportsGame = texts.some((t) => SPORTS_TRIGGER.test(t)) || artifacts.some((h) => SPORTS_ARTIFACT.test(h));

  if (input.paid) {
    // Paid unlocks the catalog on every build turn, so most paid turns are NOT
    // an ask — the softer `subject` lead-in is the honest one unless the child
    // actually said 3D. (paid is hardwired false at the call site today;
    // TECH_DEBT #11.)
    const paidReason = threeReasonFrom(texts, artifacts) ?? "subject";
    return { three: true, threeReason: paidReason, audio: true, save, ...(sportsGame ? { sports: true } : {}) };
  }

  const reason = threeReasonFrom(texts, artifacts);

  return {
    three: reason !== null,
    ...(reason ? { threeReason: reason } : {}),
    ...(reason !== null && sportsGame ? { sports: true } : {}),
    audio: texts.some((t) => AUDIO_TRIGGER.test(t)) || artifacts.some((h) => AUDIO_ARTIFACT.test(h)),
    save,
  };
}

/** Shared by catalogGates and threeUnlockReason so the two can never disagree
 *  about WHY the catalog is on. An existing 3D artifact counts as `asked`: the
 *  child is iterating on a scene that is already Three.js, and softening the
 *  wording there would invite a rebuild in flat canvas. */
function threeReasonFrom(texts: string[], artifacts: string[]): ThreeUnlockReason | null {
  if (texts.some((t) => THREE_TRIGGER.test(t)) || artifacts.some((h) => THREE_ARTIFACT.test(h))) return "asked";
  if (subjectUnlockEnabled() && texts.some((t) => subjectSuggestsThree(t))) return "subject";
  return null;
}

/** Why (or whether) this turn unlocks the 3D catalog. `null` = not unlocked.
 *  Same inputs and same nesting under the build-turn gate as catalogGates. */
export function threeUnlockReason(input: { message: string; history: ChatMessage[]; paid: boolean }): ThreeUnlockReason | null {
  return catalogGates(input).threeReason ?? null;
}
