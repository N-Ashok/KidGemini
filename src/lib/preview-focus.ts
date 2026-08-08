// Auto-focus for the game preview (owner ask 2026-08-08): a kid had to CLICK
// the preview panel before arrow keys / WASD reached the game. An iframe only
// receives keyboard events once it holds focus, and nothing was ever giving it
// focus — so every game silently began unplayable-by-keyboard.
//
// The whole risk here is stealing focus from someone who is TYPING. This module
// owns that judgement as pure logic so it can be tested without a DOM;
// ArtifactFrame just calls it and focuses the iframe. No React, no DOM.

/** The element that currently has focus, described in the only terms this
 *  decision needs. `tagName` is upper-case, exactly as the DOM reports it. */
export interface ActiveElementInfo {
  tagName: string;
  isContentEditable: boolean;
}

/** Fields a kid could be mid-sentence in — never take focus off these. */
const TEXT_ENTRY_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * Whether the preview may take keyboard focus right now.
 *
 * Yes when nothing is focused, or focus is on ordinary page furniture (BODY, a
 * button the kid just clicked). No whenever the kid is composing — the chat
 * box is the primary surface on this screen and hijacking it mid-word would be
 * a far worse bug than the one this fixes.
 */
export function shouldAutoFocusPreview(active: ActiveElementInfo | null): boolean {
  if (!active) return true;
  if (active.isContentEditable) return false;
  return !TEXT_ENTRY_TAGS.has(active.tagName.toUpperCase());
}
