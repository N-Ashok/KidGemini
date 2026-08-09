// Preview pane policy (docs/PRD-PREVIEW-PANE.md): full-screen shell classes,
// Esc-to-collapse, and the artifact-swap table that keeps the OLD game playable
// while an update generates.
import { describe, expect, it } from "vitest";
import {
  clampPanelWidth,
  keyToPanelAction,
  loadPanelWidth,
  nextArtifact,
  nextDragState,
  nextExpandOnManualToggle,
  PANEL_DEFAULT_W,
  PANEL_MIN_W,
  panelShellClass,
  previewDisplay,
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

// BUG-FIX-LOG (kid report, 2026-07-28): dragging the resize handle, then
// having the browser fire pointercancel instead of pointerup — a tab/window
// blur, a right-click, an interrupted touch gesture — left `dragging` stuck
// `true` forever in PanelResizeHandle.tsx, so its full-viewport click-blocking
// shield never unmounted; the kid had to refresh the page to click anything.
describe("nextDragState — a drag must ALWAYS end, however it ends", () => {
  it("down starts a drag", () => {
    expect(nextDragState("down", false)).toBe(true);
  });
  it("up ends a drag (the expected path)", () => {
    expect(nextDragState("up", true)).toBe(false);
  });
  it("cancel ALSO ends a drag — the actual bug: this used to be un-handled", () => {
    expect(nextDragState("cancel", true)).toBe(false);
  });
  it("cancel while not even dragging stays not-dragging (idempotent)", () => {
    expect(nextDragState("cancel", false)).toBe(false);
  });
});

describe("nextExpandOnManualToggle — expand/collapse is manual only (2026-07-15: a prior auto-expand-while-testing mechanism was removed, see BUG-FIX-LOG)", () => {
  it("toggles expanded", () => {
    expect(nextExpandOnManualToggle({ expanded: false })).toEqual({ expanded: true });
    expect(nextExpandOnManualToggle({ expanded: true })).toEqual({ expanded: false });
  });
});

describe("UPDATING_LINE", () => {
  it("is a kid-friendly non-empty line", () => {
    expect(UPDATING_LINE.length).toBeGreaterThan(10);
    expect(UPDATING_LINE).not.toMatch(/error|fail/i);
  });
});

// Shadow verify (owner report 2026-08-09: "for every edit, it is not allowing
// the kid to play the earlier version"). The cover never regressed — what grew
// is its duration, because ~1 edit in 5 now triggers a repair and repairs run
// to 60s timeouts. These pin the rule that keeps a working game reachable.
describe("previewDisplay — an edit must never take away a working game", () => {
  const OLD = "<html>old playable game</html>";
  const NEW = "<html>new version being tested</html>";

  it("mid-verify with a previous game: the CHILD KEEPS PLAYING IT, uncovered", () => {
    for (const phase of ["testing", "repairing"] as const) {
      const d = previewDisplay({ verifyingHtml: NEW, phase, lastGoodHtml: OLD });
      expect(d.visibleHtml, phase).toBe(OLD);   // the working game
      expect(d.shadowHtml, phase).toBe(NEW);    // probed out of sight
      expect(d.covered, phase).toBe(false);     // and NOT hidden behind a card
    }
  });

  it("the very first game has nothing to fall back to — cover it, no shadow", () => {
    const d = previewDisplay({ verifyingHtml: NEW, phase: "testing", lastGoodHtml: null });
    expect(d.visibleHtml).toBe(NEW);
    expect(d.shadowHtml).toBeNull();
    expect(d.covered).toBe(true);
  });

  it("treats an empty previous game as no previous game", () => {
    // "" is what usePreviewVerify passes before any html exists; it must not be
    // mistaken for a playable fallback, or the child would be shown a blank.
    const d = previewDisplay({ verifyingHtml: NEW, phase: "testing", lastGoodHtml: "" });
    expect(d.covered).toBe(true);
    expect(d.shadowHtml).toBeNull();
  });

  it("once settled, the verified version is what plays — no shadow, no cover", () => {
    const d = previewDisplay({ verifyingHtml: NEW, phase: "done", lastGoodHtml: OLD });
    expect(d.visibleHtml).toBe(NEW);
    expect(d.shadowHtml).toBeNull();
    expect(d.covered).toBe(false);
  });

  it("a settled FIRST game also plays uncovered", () => {
    const d = previewDisplay({ verifyingHtml: NEW, phase: "done", lastGoodHtml: null });
    expect(d.visibleHtml).toBe(NEW);
    expect(d.covered).toBe(false);
  });

  it("the visible document is never the one under test while a fallback exists", () => {
    // The property that matters: probes must never poke the game being played.
    for (const phase of ["testing", "repairing"] as const) {
      const d = previewDisplay({ verifyingHtml: NEW, phase, lastGoodHtml: OLD });
      expect(d.visibleHtml).not.toBe(d.shadowHtml);
    }
  });
});
