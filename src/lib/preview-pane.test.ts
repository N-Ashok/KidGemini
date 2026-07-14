// Preview pane policy (docs/PRD-PREVIEW-PANE.md): full-screen shell classes,
// Esc-to-collapse, and the artifact-swap table that keeps the OLD game playable
// while an update generates.
import { describe, expect, it } from "vitest";
import {
  clampPanelWidth,
  keyToPanelAction,
  loadPanelWidth,
  nextArtifact,
  nextExpandOnCoveredChange,
  nextExpandOnManualToggle,
  PANEL_DEFAULT_W,
  PANEL_MIN_W,
  panelShellClass,
  previewDocKey,
  savePanelWidth,
  UPDATING_LINE,
} from "./preview-pane";

describe("previewDocKey — a NEW game must never reuse an old game's doc key", () => {
  it("differs across generations even when rounds collide (v1 ends at round 1, v2 starts at round 1)", () => {
    expect(previewDocKey(2, 1)).not.toBe(previewDocKey(1, 1));
  });
  it("differs across rounds within a generation (repair/pristine reloads still remount)", () => {
    expect(previewDocKey(1, 2)).not.toBe(previewDocKey(1, 1));
  });
});

describe("panelShellClass", () => {
  it("collapsed: mobile overlay + desktop column driven by the resize var (440px default)", () => {
    const cls = panelShellClass(false);
    expect(cls).toContain("fixed inset-0");
    expect(cls).toContain("md:static");
    expect(cls).toContain("md:w-[var(--panel-w,440px)]");
    // The resize handle is absolutely positioned against the panel on md+.
    expect(cls).toContain("md:relative");
  });

  it("expanded: full-screen at every breakpoint (no md: column overrides)", () => {
    const cls = panelShellClass(true);
    expect(cls).toContain("fixed inset-0");
    expect(cls).not.toContain("md:static");
    expect(cls).not.toContain("md:w-");
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

describe("clampPanelWidth — pull-to-resize stays usable at every screen size", () => {
  it("passes through a reasonable width, rounded", () => {
    expect(clampPanelWidth(500.6, 1440)).toBe(501);
  });
  it("never narrower than PANEL_MIN_W (header buttons fell off below this)", () => {
    expect(clampPanelWidth(100, 1440)).toBe(PANEL_MIN_W);
    expect(clampPanelWidth(-50, 1440)).toBe(PANEL_MIN_W);
  });
  it("never wider than 70% of the viewport (chat must stay usable)", () => {
    expect(clampPanelWidth(2000, 1440)).toBe(Math.round(1440 * 0.7));
  });
  it("a small viewport keeps the minimum even when 70vw is below it", () => {
    expect(clampPanelWidth(1000, 400)).toBe(PANEL_MIN_W);
  });
  it("default width is itself valid on a laptop viewport", () => {
    expect(clampPanelWidth(PANEL_DEFAULT_W, 1280)).toBe(PANEL_DEFAULT_W);
  });
});

describe("panel width persistence — same never-throw contract as chat-store", () => {
  function fakeStorage(init: Record<string, string> = {}): Storage {
    const map = new Map(Object.entries(init));
    return {
      get length() {
        return map.size;
      },
      clear: () => map.clear(),
      getItem: (k: string) => map.get(k) ?? null,
      key: (i: number) => [...map.keys()][i] ?? null,
      removeItem: (k: string) => void map.delete(k),
      setItem: (k: string, v: string) => void map.set(k, v),
    };
  }

  it("round-trips a saved width", () => {
    const s = fakeStorage();
    savePanelWidth(s, 612);
    expect(loadPanelWidth(s)).toBe(612);
  });
  it("returns null for absent or garbage values", () => {
    expect(loadPanelWidth(fakeStorage())).toBeNull();
    expect(loadPanelWidth(fakeStorage({ "kidgemini:panel-w:v1": "banana" }))).toBeNull();
    expect(loadPanelWidth(fakeStorage({ "kidgemini:panel-w:v1": "-20" }))).toBeNull();
  });
  it("save never throws (quota / private mode)", () => {
    const s = fakeStorage();
    s.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    expect(() => savePanelWidth(s, 500)).not.toThrow();
  });
});

describe("nextExpandOnCoveredChange — auto-expand while loading, even on laptop (2026-07-14)", () => {
  it("a fresh game starting to load (covered=true) expands from collapsed, marked as auto", () => {
    const next = nextExpandOnCoveredChange(true, { expanded: false, wasAutoExpanded: false });
    expect(next).toEqual({ expanded: true, wasAutoExpanded: true });
  });

  it("finishing (covered=false) after an AUTO expand reverts to collapsed", () => {
    const next = nextExpandOnCoveredChange(false, { expanded: true, wasAutoExpanded: true });
    expect(next).toEqual({ expanded: false, wasAutoExpanded: false });
  });

  it("already expanded when loading starts is left alone — not re-marked as auto", () => {
    const state = { expanded: true, wasAutoExpanded: false };
    expect(nextExpandOnCoveredChange(true, state)).toBe(state); // same reference: no-op
  });

  it("finishing after a MANUAL expand (not auto) stays expanded — the user's choice always wins", () => {
    const state = { expanded: true, wasAutoExpanded: false };
    expect(nextExpandOnCoveredChange(false, state)).toBe(state);
  });

  it("finishing while already collapsed and never auto-expanded is a no-op", () => {
    const state = { expanded: false, wasAutoExpanded: false };
    expect(nextExpandOnCoveredChange(false, state)).toBe(state);
  });
});

describe("nextExpandOnManualToggle — a deliberate click always wins over auto-expand bookkeeping", () => {
  it("toggles expanded and clears the auto-expand flag", () => {
    expect(nextExpandOnManualToggle({ expanded: false, wasAutoExpanded: true })).toEqual({
      expanded: true,
      wasAutoExpanded: false,
    });
    expect(nextExpandOnManualToggle({ expanded: true, wasAutoExpanded: false })).toEqual({
      expanded: false,
      wasAutoExpanded: false,
    });
  });
});

describe("UPDATING_LINE", () => {
  it("is a kid-friendly non-empty line", () => {
    expect(UPDATING_LINE.length).toBeGreaterThan(10);
    expect(UPDATING_LINE).not.toMatch(/error|fail/i);
  });
});
