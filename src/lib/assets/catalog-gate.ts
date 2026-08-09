// Tier/keyword catalog gate (PRD-3D-GAMES-AND-ASSETS §9). Decides which
// prompt catalogs a turn carries. Nested under the build-turn gate so
// chit-chat pays zero catalog tokens (TECH_DEBT #33); 3D and audio gate
// independently (a 2D "platformer with sound" gets SFX, no 3D). Cheap
// regexes only — no LLM call, no I/O. Pure logic, no React/Next.

import type { ChatMessage } from "@/types/chat.types";
import { isGameBuildTurn, THREE_ASK_RE } from "../builder-mode";

export interface CatalogGates {
  three: boolean; // engine + model catalog (they travel together: models need the engine)
  audio: boolean; // sfx + music catalog (works in 2D games — no engine implied)
  // Save & continue building clause (docs/2026-08-01_PRD_SaveContinueBuilding.md
  // §3a). Optional — not every CatalogGates literal in this codebase's tests
  // was written with save-awareness, and undefined behaves as false (falsy),
  // same as omitting three/audio would if they were optional. New call sites
  // should set it explicitly; catalogGates() itself always returns it.
  save?: boolean;
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
const THREE_TRIGGER = THREE_ASK_RE;
const AUDIO_TRIGGER = /\b(sounds?|music|songs?|sfx)\b/i;
// Build/world/inventory mechanics (docs/2026-08-01_PRD_SaveContinueBuilding.md):
// a kid naming placement/persistence mechanics, not just "make me a game".
const SAVE_TRIGGER = /\b(build|building|stack|stacking|place|placing|placed|inventory|world|city|base)\b/i;

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

  if (input.paid) return { three: true, audio: true, save };

  return {
    three: texts.some((t) => THREE_TRIGGER.test(t)) || artifacts.some((h) => THREE_ARTIFACT.test(h)),
    audio: texts.some((t) => AUDIO_TRIGGER.test(t)) || artifacts.some((h) => AUDIO_ARTIFACT.test(h)),
    save,
  };
}
