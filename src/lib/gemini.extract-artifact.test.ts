// extractArtifact's `wasFenced` flag (BUG-FIX-LOG 2026-07-14, "unfenced game
// code corrupts the chat bubble"): the caller (api/chat/route.ts) needs to know
// whether the model's reply already had a clean, closed ```html fence, or
// whether extractArtifact had to fall back to a tolerant heuristic (open-only
// fence, or no fence at all). Only the fallback cases need their DISPLAY text
// re-fenced before it reaches the markdown renderer — re-fencing an
// already-clean case-1 reply would risk reordering trailing prose.
import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { extractArtifact } from "./gemini";

describe("extractArtifact — wasFenced", () => {
  it("A.1 a properly closed fence is wasFenced: true", () => {
    const r = extractArtifact("Here you go!\n```html\n<!doctype html><html><body>GAME</body></html>\n```");
    expect(r.artifactHtml).toContain("GAME");
    expect(r.wasFenced).toBe(true);
  });

  it("A.2 an opened-but-never-closed fence is wasFenced: false", () => {
    const r = extractArtifact("Here you go!\n```html\n<!doctype html><html><body>GAME");
    expect(r.artifactHtml).toContain("GAME");
    expect(r.wasFenced).toBe(false);
  });

  it("A.3 no fence at all (bare document) is wasFenced: false", () => {
    const r = extractArtifact("<!doctype html><html><body>GAME</body></html>");
    expect(r.artifactHtml).toContain("GAME");
    expect(r.wasFenced).toBe(false);
  });

  it("A.4 plain prose with no artifact leaves wasFenced undefined", () => {
    const r = extractArtifact("Bamboo! Lots and lots of bamboo. 🐼");
    expect(r.artifactHtml).toBeUndefined();
    expect(r.wasFenced).toBeUndefined();
  });
});
