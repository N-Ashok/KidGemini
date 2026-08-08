/** Auto-focus for the game preview (owner ask 2026-08-08). The kid used to
 *  have to click the preview before the keyboard reached the game. The only
 *  thing that must never happen is stealing focus mid-typing. */
import { describe, it, expect } from "vitest";
import { shouldAutoFocusPreview } from "./preview-focus";

describe("shouldAutoFocusPreview", () => {
  it("focuses when nothing holds focus", () => {
    expect(shouldAutoFocusPreview(null)).toBe(true);
  });

  it("focuses over ordinary page furniture (BODY, a just-clicked button)", () => {
    expect(shouldAutoFocusPreview({ tagName: "BODY", isContentEditable: false })).toBe(true);
    expect(shouldAutoFocusPreview({ tagName: "BUTTON", isContentEditable: false })).toBe(true);
    expect(shouldAutoFocusPreview({ tagName: "DIV", isContentEditable: false })).toBe(true);
  });

  // The regression that would matter most: a kid typing their next idea into
  // the chat box, and the game yanking the cursor away mid-word.
  it("NEVER steals focus from a text field the kid may be typing in", () => {
    expect(shouldAutoFocusPreview({ tagName: "TEXTAREA", isContentEditable: false })).toBe(false);
    expect(shouldAutoFocusPreview({ tagName: "INPUT", isContentEditable: false })).toBe(false);
    expect(shouldAutoFocusPreview({ tagName: "SELECT", isContentEditable: false })).toBe(false);
  });

  it("NEVER steals focus from a contenteditable, whatever its tag", () => {
    expect(shouldAutoFocusPreview({ tagName: "DIV", isContentEditable: true })).toBe(false);
  });

  it("is case-insensitive about tagName (React/DOM casing differences)", () => {
    expect(shouldAutoFocusPreview({ tagName: "textarea", isContentEditable: false })).toBe(false);
  });
});
