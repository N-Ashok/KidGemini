// Multiplayer prompt gate (PRD-MULTIPLAYER.md Phase 4, Ariantra-Platform repo).
// Nested under the build-turn gate so chit-chat pays zero tokens (same
// discipline as assets/catalog-gate.ts, TECH_DEBT #33). Independent of the 3D/
// audio catalogs — a multiplayer game can be plain 2D and silent — so this is
// its own gate, not a third CatalogGates field. Cheap regex only, no I/O.

import type { ChatMessage } from "@/types/chat.types";
import { isGameBuildTurn } from "./builder-mode";

// Word-bounded so "versatile"/"versus-ish" don't fire. Errs toward unlocking
// (same §9 philosophy as the asset catalogs): a false unlock costs a few
// prompt tokens; an under-unlock silently ships a single-player game when the
// kid asked to play with a friend.
const MULTIPLAYER_TRIGGER = /\b(multiplayer|(2|two)[- ]?player|co-?op|with (a|my) friend|versus|vs\.?|race (against|with)|play together)\b/i;

/** The opt-in marker the model writes (multiplayer-prompt.ts teaches it) — the
 *  same string ArtifactFrame checks to decide whether to show "🎮 Invite a
 *  friend to test" at all (a single-player game showing that button would be
 *  a dead end). Mirrors THREE_MARKER's role in assets/inject.ts. */
export const MULTIPLAYER_MARKER = "<!--USES_MULTIPLAYER-->";

// Iteration insurance: a game already built with the platform's multiplayer
// overlay keeps the section on follow-up turns even once the keyword text has
// scrolled out of view — mirrors THREE_ARTIFACT/AUDIO_ARTIFACT.
const MULTIPLAYER_ARTIFACT = /USES_MULTIPLAYER/;

export function multiplayerGate(input: { message: string; history: ChatMessage[] }): boolean {
  if (!isGameBuildTurn(input.message, input.history)) return false;
  const texts = [input.message, ...input.history.filter((m) => m.role === "child").map((m) => m.text)];
  const artifacts = input.history.map((m) => m.artifactHtml).filter((h): h is string => Boolean(h));
  return texts.some((t) => MULTIPLAYER_TRIGGER.test(t)) || artifacts.some((h) => MULTIPLAYER_ARTIFACT.test(h));
}
