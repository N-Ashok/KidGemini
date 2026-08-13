// Regression test for BUG-FIX-LOG 2026-08-12 (TECH_DEBT #101): the model
// sometimes emits the trailing `NEXT_ASKS:` sentinel INSIDE the ```html
// fence instead of after it — extractArtifact then captures it as part of
// artifactHtml, so it renders as stray visible text at the bottom of the
// kid's game, AND parseNextAskLine (which only ever looks at the fence's
// prose) never finds it, so the suggestion chips silently don't show either.
// Confirmed live twice: production (Lemonade Empire, 2026-08-10, "Card
// jatinbhagatnew's Lemonade Empire") and the first fresh-build turn of the
// two-pass pipeline UAT (Leapfrog Lake, 2026-08-12).
import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { extractArtifact } from "./gemini";
import { parseNextAskLine } from "./next-ask-sentinel";

describe("extractArtifact — reclaims a NEXT_ASKS line leaked inside the fence", () => {
  it("N.1 sentinel after </html> but before the closing ``` fence never reaches artifactHtml", () => {
    const reply =
      'Here you go!\n```html\n<!doctype html><html><body>GAME</body></html>\nNEXT_ASKS: Can we add a jump pad? | Could dragonflies give points? | What flowers grow at the lake?\n```';
    const r = extractArtifact(reply);

    expect(r.artifactHtml).not.toContain("NEXT_ASKS");
    expect(r.artifactHtml?.trim().toLowerCase().endsWith("</html>")).toBe(true);
  });

  it("N.2 the reclaimed sentinel is recoverable by the SAME parseNextAskLine the normal (non-leaked) path uses", () => {
    const reply =
      'Here you go!\n```html\n<!doctype html><html><body>GAME</body></html>\nNEXT_ASKS: Can we add a jump pad? | Could dragonflies give points? | What flowers grow at the lake?\n```';
    const r = extractArtifact(reply);

    const parsed = parseNextAskLine(r.text);
    expect(parsed).not.toBeNull();
    expect(parsed?.ideas).toEqual([
      "Can we add a jump pad?",
      "Could dragonflies give points?",
      "What flowers grow at the lake?",
    ]);
  });

  it("N.3 a doubled closing </html> tag inside the fence is also cleaned up", () => {
    const reply = 'Here you go!\n```html\n<!doctype html><html><body>GAME</body></html>\n</html>\n```';
    const r = extractArtifact(reply);

    expect((r.artifactHtml?.match(/<\/html\s*>/gi) ?? []).length).toBe(1);
  });

  it("N.4 well-formed output (sentinel correctly OUTSIDE the fence) is untouched", () => {
    const reply =
      'Here you go!\n```html\n<!doctype html><html><body>GAME</body></html>\n```\nNEXT_ASKS: a | b | c';
    const r = extractArtifact(reply);

    expect(r.artifactHtml?.trim()).toBe("<!doctype html><html><body>GAME</body></html>");
    expect(r.text.endsWith("NEXT_ASKS: a | b | c")).toBe(true);
  });

  it("N.5 the open-fence (never closed) fallback also reclaims a leaked sentinel", () => {
    const reply =
      'Here you go!\n```html\n<!doctype html><html><body>GAME</body></html>\nNEXT_ASKS: a | b | c';
    const r = extractArtifact(reply);

    expect(r.artifactHtml).not.toContain("NEXT_ASKS");
    const parsed = parseNextAskLine(r.text);
    expect(parsed?.ideas).toEqual(["a", "b", "c"]);
  });

  it("N.6 the bare-document (no fence at all) fallback also reclaims a leaked sentinel", () => {
    const reply = "<!doctype html><html><body>GAME</body></html>\nNEXT_ASKS: a | b | c";
    const r = extractArtifact(reply);

    expect(r.artifactHtml).not.toContain("NEXT_ASKS");
    const parsed = parseNextAskLine(r.text);
    expect(parsed?.ideas).toEqual(["a", "b", "c"]);
  });

  it("N.7 genuine unrecognized trailing junk after </html> is dropped, not surfaced as chat prose", () => {
    const reply = 'Here you go!\n```html\n<!doctype html><html><body>GAME</body></html>\nrandom garbage\n```';
    const r = extractArtifact(reply);

    expect(r.artifactHtml?.trim().toLowerCase().endsWith("</html>")).toBe(true);
    expect(r.text).not.toContain("random garbage");
  });
});
