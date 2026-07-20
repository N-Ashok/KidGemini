// Tier/keyword catalog gate (PRD-3D-GAMES-AND-ASSETS §9). Decides which
// prompt catalogs a turn carries. Nested under the build-turn gate so
// chit-chat pays zero catalog tokens (TECH_DEBT #33); 3D and audio gate
// independently (a 2D "platformer with sound" gets SFX, no 3D). Cheap
// regexes only — no LLM call, no I/O. Pure logic, no React/Next.

import type { ChatMessage } from "@/types/chat.types";
import { isGameBuildTurn } from "../builder-mode";

export interface CatalogGates {
  three: boolean; // engine + model catalog (they travel together: models need the engine)
  audio: boolean; // sfx + music catalog (works in 2D games — no engine implied)
}

// Free-tier triggers (§9): err toward unlocking — a false unlock costs a few
// catalog tokens; an under-unlock is a kid asking for sound and getting
// silence. Word-bounded so "grade3d" / "musical" don't fire.
const THREE_TRIGGER = /\b3d\b/i;
const AUDIO_TRIGGER = /\b(sounds?|music|songs?|sfx)\b/i;

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

/** The §9 decision tree: build turn? → paid: both · free: keyword scan over
 *  the message AND the child's prior messages AND prior artifacts. Paid is
 *  hardwired false at the call site until entitlement lands (TECH_DEBT #11) —
 *  then the caller passes the real entitlement and paid goes always-on. */
export function catalogGates(input: { message: string; history: ChatMessage[]; paid: boolean }): CatalogGates {
  if (!isGameBuildTurn(input.message, input.history)) return { three: false, audio: false };
  if (input.paid) return { three: true, audio: true };

  const texts = [input.message, ...input.history.filter((m) => m.role === "child").map((m) => m.text)];
  const artifacts = input.history.map((m) => m.artifactHtml).filter((h): h is string => Boolean(h));
  return {
    three: texts.some((t) => THREE_TRIGGER.test(t)) || artifacts.some((h) => THREE_ARTIFACT.test(h)),
    audio: texts.some((t) => AUDIO_TRIGGER.test(t)) || artifacts.some((h) => AUDIO_ARTIFACT.test(h)),
  };
}
