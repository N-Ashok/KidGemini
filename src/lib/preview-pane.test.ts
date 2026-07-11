// Preview pane policy (docs/PRD-PREVIEW-PANE.md): full-screen shell classes,
// Esc-to-collapse, and the artifact-swap table that keeps the OLD game playable
// while an update generates.
import { describe, expect, it } from "vitest";
import { keyToPanelAction, nextArtifact, panelShellClass, previewDocKey, UPDATING_LINE } from "./preview-pane";

describe("previewDocKey — a NEW game must never reuse an old game's doc key", () => {
  it("differs across generations even when rounds collide (v1 ends at round 1, v2 starts at round 1)", () => {
    expect(previewDocKey(2, 1)).not.toBe(previewDocKey(1, 1));
  });
  it("differs across rounds within a generation (repair/pristine reloads still remount)", () => {
    expect(previewDocKey(1, 2)).not.toBe(previewDocKey(1, 1));
  });
});

describe("panelShellClass", () => {
  it("collapsed: mobile overlay + desktop 440px column", () => {
    const cls = panelShellClass(false);
    expect(cls).toContain("fixed inset-0");
    expect(cls).toContain("md:static");
    expect(cls).toContain("md:w-[440px]");
  });

  it("expanded: full-screen at every breakpoint (no md: column overrides)", () => {
    const cls = panelShellClass(true);
    expect(cls).toContain("fixed inset-0");
    expect(cls).not.toContain("md:static");
    expect(cls).not.toContain("md:w-[440px]");
  });

  it("both states sit ABOVE the brand nav (z-100) — BUG-FIX-LOG 2026-07-07 'can't come out'", () => {
    expect(panelShellClass(false)).toContain("z-[110]");
    expect(panelShellClass(true)).toContain("z-[110]");
  });
});

describe("keyToPanelAction", () => {
  it("Esc collapses an expanded panel", () => {
    expect(keyToPanelAction("Escape", true)).toBe("collapse");
  });
  it("Esc does nothing when not expanded", () => {
    expect(keyToPanelAction("Escape", false)).toBeNull();
  });
  it("other keys never collapse", () => {
    expect(keyToPanelAction("Enter", true)).toBeNull();
    expect(keyToPanelAction("f", true)).toBeNull();
  });
});

describe("nextArtifact — old game stays playable until the new one is done", () => {
  const OLD = "<html>old game</html>";
  const NEW = "<html>new game</html>";

  it("done WITH html swaps in the new game", () => {
    expect(nextArtifact({ type: "done", artifactHtml: NEW }, OLD)).toBe(NEW);
  });
  it("done WITHOUT html (prose-only reply) keeps the old game", () => {
    expect(nextArtifact({ type: "done" }, OLD)).toBe(OLD);
    expect(nextArtifact({ type: "done", artifactHtml: null }, OLD)).toBe(OLD);
  });
  it("regenerate keeps the old game running (panel must NOT blank)", () => {
    expect(nextArtifact({ type: "regenerate" }, OLD)).toBe(OLD);
  });
  it("send keeps the old game running while the update streams", () => {
    expect(nextArtifact({ type: "send" }, OLD)).toBe(OLD);
  });
  it("safety retract clears the panel — fail closed beats continuity", () => {
    expect(nextArtifact({ type: "retract" }, OLD)).toBeNull();
  });
  it("no current game stays empty on keep-style events", () => {
    expect(nextArtifact({ type: "regenerate" }, null)).toBeNull();
    expect(nextArtifact({ type: "done" }, null)).toBeNull();
  });
});

describe("UPDATING_LINE", () => {
  it("is a kid-friendly non-empty line", () => {
    expect(UPDATING_LINE.length).toBeGreaterThan(10);
    expect(UPDATING_LINE).not.toMatch(/error|fail/i);
  });
});
