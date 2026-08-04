// Kid-facing "running slow" banner (docs/2026-07-30_PRD_PreviewPerfPanel.md
// addendum): a symptom the kid already recognizes ("this feels stuck"), never
// the technical per-model breakdown the debug Perf tab shows. Two pure,
// framework-free pieces, same house style as idea-mic.ts / stuck-signal.ts:
//  - nextSlowdownBannerState(): a small state machine — N CONSECUTIVE
//    low-fps samples before showing (never a single dipped frame), and a
//    cooldown after "Make it faster" is tapped so the nudge doesn't spam
//    while a fix request is in flight.
//  - buildSlowdownHint(): turns the latest PerfSnapshot's model list into the
//    real technical hint sent to chat on the kid's behalf — the kid never
//    sees this string, only the button.
import { describe, expect, it } from "vitest";
import {
  COOLDOWN_MS,
  LOW_FPS_THRESHOLD,
  SUSTAINED_LOW_SAMPLES,
  initialSlowdownBannerState,
  nextSlowdownBannerState,
  buildSlowdownHint,
  heaviestModel,
  type SlowdownBannerState,
} from "./slowdown-nudge";
import type { PerfModelEntry } from "@/types/preview-perf.types";

function model(overrides: Partial<PerfModelEntry> = {}): PerfModelEntry {
  return {
    name: "grandpa",
    triangles: 40_000,
    instances: 3,
    animated: true,
    load: 240_000,
    bucket: "red",
    ...overrides,
  };
}

describe("nextSlowdownBannerState — debounced sustained-low-FPS banner", () => {
  it("starts hidden", () => {
    expect(initialSlowdownBannerState.visible).toBe(false);
  });

  it("does NOT show on a single dipped frame (avoid flapping on a one-off hiccup)", () => {
    const s = nextSlowdownBannerState(initialSlowdownBannerState, {
      type: "sample",
      fps: LOW_FPS_THRESHOLD - 1,
      now: 0,
    });
    expect(s.visible).toBe(false);
    expect(s.consecutiveLow).toBe(1);
  });

  it("a single dip surrounded by healthy frames never accumulates", () => {
    let s = initialSlowdownBannerState;
    s = nextSlowdownBannerState(s, { type: "sample", fps: LOW_FPS_THRESHOLD - 1, now: 0 });
    s = nextSlowdownBannerState(s, { type: "sample", fps: 60, now: 1_000 });
    expect(s.visible).toBe(false);
    expect(s.consecutiveLow).toBe(0);
  });

  it("shows once FPS has been low for SUSTAINED_LOW_SAMPLES consecutive samples", () => {
    let s: SlowdownBannerState = initialSlowdownBannerState;
    for (let i = 0; i < SUSTAINED_LOW_SAMPLES - 1; i++) {
      s = nextSlowdownBannerState(s, { type: "sample", fps: 10, now: i * 1_000 });
      expect(s.visible).toBe(false);
    }
    s = nextSlowdownBannerState(s, {
      type: "sample",
      fps: 10,
      now: (SUSTAINED_LOW_SAMPLES - 1) * 1_000,
    });
    expect(s.visible).toBe(true);
  });

  it("a fps exactly AT the threshold does not count as low (threshold is exclusive)", () => {
    const s = nextSlowdownBannerState(initialSlowdownBannerState, {
      type: "sample",
      fps: LOW_FPS_THRESHOLD,
      now: 0,
    });
    expect(s.consecutiveLow).toBe(0);
  });

  it("hides again once FPS recovers (the symptom is gone, so is the nudge)", () => {
    let s: SlowdownBannerState = initialSlowdownBannerState;
    for (let i = 0; i < SUSTAINED_LOW_SAMPLES; i++) {
      s = nextSlowdownBannerState(s, { type: "sample", fps: 5, now: i * 1_000 });
    }
    expect(s.visible).toBe(true);
    s = nextSlowdownBannerState(s, { type: "sample", fps: 60, now: SUSTAINED_LOW_SAMPLES * 1_000 });
    expect(s.visible).toBe(false);
    expect(s.consecutiveLow).toBe(0);
  });

  it("tapping 'Make it faster' hides the banner and starts a cooldown", () => {
    let s: SlowdownBannerState = initialSlowdownBannerState;
    for (let i = 0; i < SUSTAINED_LOW_SAMPLES; i++) {
      s = nextSlowdownBannerState(s, { type: "sample", fps: 5, now: i * 1_000 });
    }
    expect(s.visible).toBe(true);
    s = nextSlowdownBannerState(s, { type: "fixTapped", now: 5_000 });
    expect(s.visible).toBe(false);
    expect(s.cooldownUntil).toBe(5_000 + COOLDOWN_MS);
  });

  it("during cooldown, sustained-low samples do NOT re-show the banner (no spamming a fix already in flight)", () => {
    let s: SlowdownBannerState = { visible: false, consecutiveLow: 0, cooldownUntil: 10_000 };
    for (let i = 0; i < SUSTAINED_LOW_SAMPLES + 2; i++) {
      s = nextSlowdownBannerState(s, { type: "sample", fps: 5, now: 5_000 + i * 500 });
      expect(s.visible).toBe(false);
    }
  });

  it("once the cooldown window passes, low FPS can re-trigger the banner", () => {
    let s: SlowdownBannerState = { visible: false, consecutiveLow: 0, cooldownUntil: 10_000 };
    // Still cooling down.
    s = nextSlowdownBannerState(s, { type: "sample", fps: 5, now: 9_999 });
    expect(s.cooldownUntil).toBe(10_000);
    // Cooldown has elapsed — the clock resets and counting starts fresh.
    for (let i = 0; i < SUSTAINED_LOW_SAMPLES; i++) {
      s = nextSlowdownBannerState(s, { type: "sample", fps: 5, now: 10_000 + i * 1_000 });
    }
    expect(s.visible).toBe(true);
    expect(s.cooldownUntil).toBeNull();
  });

  it("'reset' (new game / new generation) clears everything back to initial", () => {
    let s: SlowdownBannerState = { visible: true, consecutiveLow: 9, cooldownUntil: 99_999 };
    s = nextSlowdownBannerState(s, { type: "reset" });
    expect(s).toEqual(initialSlowdownBannerState);
  });
});

describe("heaviestModel — shared by buildSlowdownHint and the server-log report, so they never disagree", () => {
  it("returns null for an empty scene", () => {
    expect(heaviestModel([])).toBeNull();
  });

  it("picks the highest-load entry regardless of input order", () => {
    const m = heaviestModel([model({ name: "light", load: 1 }), model({ name: "heavy", load: 999_999 })]);
    expect(m?.name).toBe("heavy");
  });
});

describe("buildSlowdownHint — the REAL technical context sent to chat, never shown to the kid", () => {
  it("names the heaviest model, its instance count and animated state", () => {
    const hint = buildSlowdownHint([
      model({ name: "fielder", instances: 9, animated: true, load: 50_000 }),
      model({ name: "grandpa", instances: 3, animated: true, load: 240_000 }),
    ]);
    expect(hint).toContain("grandpa");
    expect(hint).toContain("3 instances");
    expect(hint).toContain("animated");
    expect(hint).not.toContain("fielder"); // only the worst offender, not the whole list
  });

  it("picks the highest-load model regardless of input order (defensive — doesn't trust caller's sort)", () => {
    const hint = buildSlowdownHint([
      model({ name: "heavy", load: 999_999 }),
      model({ name: "light", load: 1 }),
    ]);
    expect(hint).toContain("heavy");
  });

  it("a single, non-animated instance reads naturally (no 'instances', no 'animated')", () => {
    const hint = buildSlowdownHint([model({ name: "grandpa", instances: 1, animated: false })]);
    expect(hint).toContain("1 instance");
    expect(hint).not.toContain("1 instances");
    expect(hint).not.toContain("animated");
  });

  it("never mentions triangles or raw numbers a kid wouldn't recognize as model internals", () => {
    const hint = buildSlowdownHint([model({ name: "grandpa", triangles: 40_000 })]);
    expect(hint).not.toContain("40000");
    expect(hint).not.toContain("40,000");
  });

  it("falls back to a generic, still-actionable hint when no model is currently heavy (e.g. a pure 2D game)", () => {
    const hint = buildSlowdownHint([]);
    expect(hint.length).toBeGreaterThan(0);
    expect(hint.toLowerCase()).toContain("slow");
  });

  it("always says not to change what the game is about — the fix must stay in scope", () => {
    const hint = buildSlowdownHint([model()]);
    expect(hint).toContain("without changing what the game is about");
  });
});
