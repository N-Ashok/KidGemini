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
  buildAutoFixHint,
  buildSlowdownHint,
  heaviestModel,
  isDrawCallBound,
  shouldAutoFixSlowdown,
  type SlowdownBannerState,
  MAX_AUTO_FIXES_PER_SESSION,
  AUTO_FIX_ENABLED,
  autoFixBoundsAllow,
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

  // Owner report 2026-08-06: the banner fired on games that weren't being
  // PLAYED at all — an unstarted game or an idle multiplayer lobby renders
  // few/zero frames by DESIGN (frame governor, no game loop yet), and the
  // probe's near-zero fps readings satisfied the 5-low-samples rule. "Slow"
  // is a claim about frames arriving slowly DURING play, so a sample taken
  // while not playing (no frames, or no recent input) must never build the
  // streak — and must not hide an already-visible banner either (the kid
  // pauses to READ the banner; that pause is itself "not playing").
  it("samples while NOT playing never accumulate a streak or show the banner", () => {
    let s = initialSlowdownBannerState;
    for (let i = 0; i < SUSTAINED_LOW_SAMPLES * 2; i++) {
      s = nextSlowdownBannerState(s, { type: "sample", fps: 0, now: i * 1_000, playing: false });
    }
    expect(s.visible).toBe(false);
    expect(s.consecutiveLow).toBe(0);
  });

  it("an idle gap mid-streak resets the count — resuming play needs a FRESH sustained run", () => {
    let s = initialSlowdownBannerState;
    for (let i = 0; i < SUSTAINED_LOW_SAMPLES - 1; i++) {
      s = nextSlowdownBannerState(s, { type: "sample", fps: 10, now: i * 1_000, playing: true });
    }
    s = nextSlowdownBannerState(s, { type: "sample", fps: 0, now: 5_000, playing: false });
    s = nextSlowdownBannerState(s, { type: "sample", fps: 10, now: 6_000, playing: true });
    expect(s.visible).toBe(false);
    expect(s.consecutiveLow).toBe(1);
  });

  it("a not-playing sample does NOT hide a banner that already fired (kid may be reading it)", () => {
    let s = initialSlowdownBannerState;
    for (let i = 0; i < SUSTAINED_LOW_SAMPLES; i++) {
      s = nextSlowdownBannerState(s, { type: "sample", fps: 10, now: i * 1_000, playing: true });
    }
    expect(s.visible).toBe(true);
    s = nextSlowdownBannerState(s, { type: "sample", fps: 0, now: 10_000, playing: false });
    expect(s.visible).toBe(true);
  });

  it("omitted `playing` (old probe still cached in a game) keeps the previous behavior", () => {
    let s = initialSlowdownBannerState;
    for (let i = 0; i < SUSTAINED_LOW_SAMPLES; i++) {
      s = nextSlowdownBannerState(s, { type: "sample", fps: 10, now: i * 1_000 });
    }
    expect(s.visible).toBe(true);
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

  // ── Draw-call-aware hints (2026-08-10, the AutoRicksaw lesson) ────────────
  // The owner's slow game was profiled at 1,250 draw calls/frame with only two
  // static trees tracked — the heaviest-model hint sent Ari after the wrong
  // target NINE times (each "fix" applied GPU tweaks; the real cost was
  // thousands of hand-built meshes the model accounting cannot see). When
  // draw calls are high and no tracked model is heavy, the hint must
  // prescribe merging/instancing instead of blaming an innocent model.

  it("high draw calls + only light models → prescribes merging/instancing, names no model", () => {
    const hint = buildSlowdownHint([model({ name: "tree", instances: 2, load: 100, bucket: "green" })], 1250);
    expect(hint.toLowerCase()).toContain("draw");
    expect(hint).toMatch(/Instanced|instanc|merge|batch/i);
    expect(hint).not.toContain("tree");
    expect(hint).toContain("without changing what the game is about");
  });

  it("high draw calls + NO tracked models → the same merging prescription", () => {
    const hint = buildSlowdownHint([], 900);
    expect(hint.toLowerCase()).toContain("draw");
    expect(hint).toMatch(/merge|instanc|batch/i);
  });

  it("a genuinely heavy model still wins over the draw-call story", () => {
    // A red model IS the dominant cost — naming it stays correct even when
    // draw calls are also elevated.
    const hint = buildSlowdownHint([model({ name: "grandpa", load: 999_999, bucket: "red" })], 1250);
    expect(hint).toContain("grandpa");
  });

  it("low draw calls change nothing — the model hint stands", () => {
    const hint = buildSlowdownHint([model({ name: "grandpa" })], 120);
    expect(hint).toContain("grandpa");
  });

  it("unknown draw calls (old probe, null) change nothing", () => {
    const hint = buildSlowdownHint([model({ name: "grandpa" })], null);
    expect(hint).toContain("grandpa");
  });
});

describe("isDrawCallBound — shared gate between buildSlowdownHint and the proactive auto-fix", () => {
  it("true when draws exceed the threshold and no model is heavy", () => {
    expect(isDrawCallBound([model({ bucket: "green" })], 1250)).toBe(true);
  });

  it("false when a genuinely heavy model dominates instead", () => {
    expect(isDrawCallBound([model({ bucket: "red" })], 1250)).toBe(false);
  });

  it("false under the threshold, false on null/undefined draws", () => {
    expect(isDrawCallBound([], 120)).toBe(false);
    expect(isDrawCallBound([], null)).toBe(false);
    expect(isDrawCallBound([], undefined)).toBe(false);
  });
});

// These describe the TRIGGER semantics, which still matter: the proactive
// fix is switched off (2026-08-16) but its rules must stay correct and
// exercised underneath the switch, so it can never come back subtly wrong.
// They now pin autoFixBoundsAllow directly; shouldAutoFixSlowdown returns
// false unconditionally while AUTO_FIX_ENABLED is false.
describe("autoFixBoundsAllow — proactive nudge trigger (owner decision 2026-08-10, no tap/fps wait)", () => {
  it("fires the first time a fresh docKey is draw-call-bound", () => {
    expect(
      autoFixBoundsAllow({
        docKey: "gen-1",
        lastAutoFixedDocKey: null,
        models: [],
        drawCalls: 1250,
        busy: false,
      }),
    ).toBe(true);
  });

  it("does NOT fire again for the SAME docKey (one-shot per document — no tight loop on a soft-failed patch)", () => {
    expect(
      autoFixBoundsAllow({
        docKey: "gen-1",
        lastAutoFixedDocKey: "gen-1",
        models: [],
        drawCalls: 1250,
        busy: false,
      }),
    ).toBe(false);
  });

  it("fires again once the fix (or any edit) produces a NEW docKey that's still draw-call-bound", () => {
    expect(
      autoFixBoundsAllow({
        docKey: "gen-2",
        lastAutoFixedDocKey: "gen-1",
        models: [],
        drawCalls: 900,
        busy: false,
      }),
    ).toBe(true);
  });

  it("does not fire when the scene isn't actually draw-call-bound", () => {
    expect(
      autoFixBoundsAllow({
        docKey: "gen-1",
        lastAutoFixedDocKey: null,
        models: [],
        drawCalls: 120,
        busy: false,
      }),
    ).toBe(false);
  });

  // ── Regression: production incident 2026-08-11 ─────────────────────────
  // handleSend has no concurrency guard — the silent auto-fix turn fired
  // WHILE the kid's own edit was still streaming, two concurrent runStream()
  // calls raced the artifact/docKey update mid-generation, and the preview's
  // WebGL context got stuck on a blue screen recoverable only by a forced
  // remount (switching to the Code tab and back, which also restarted the
  // game). Must never fire while a turn is already in flight.
  it("does NOT fire while a turn is already streaming, even on an otherwise-eligible fresh docKey", () => {
    expect(
      autoFixBoundsAllow({
        docKey: "gen-1",
        lastAutoFixedDocKey: null,
        models: [],
        drawCalls: 1250,
        busy: true,
      }),
    ).toBe(false);
  });

  it("does NOT consume the docKey when skipped for busy — retries once the turn finishes", () => {
    const argsWhileBusy = {
      docKey: "gen-1",
      lastAutoFixedDocKey: null,
      models: [],
      drawCalls: 1250,
      busy: true,
    };
    expect(autoFixBoundsAllow(argsWhileBusy)).toBe(false);
    // Caller never advances lastAutoFixedDocKey on a false return (see
    // ArtifactFrame.tsx) — the SAME docKey must still fire once busy clears.
    expect(autoFixBoundsAllow({ ...argsWhileBusy, busy: false })).toBe(true);
  });
});

describe("buildAutoFixHint — the silent proactive turn's full prompt", () => {
  it("carries the same technical fix as buildSlowdownHint's draw-call branch", () => {
    const hint = buildAutoFixHint([model({ bucket: "green" })], 1250);
    expect(hint).toMatch(/Instanced|instanc|merge|batch/i);
  });

  it("instructs the model to explain itself in ONE plain, kid-friendly sentence", () => {
    const hint = buildAutoFixHint([], 1250);
    expect(hint.toLowerCase()).toContain("did not ask");
    expect(hint.toLowerCase()).toContain("one short, friendly sentence");
    expect(hint.toLowerCase()).toContain("no numbers");
  });
});

describe("the proactive auto-fix is OFF (2026-08-16)", () => {
  // Owner, after the repeated "I've tidied up the village" turns: "it broke
  // the whole game. all the meshes were gone. that was bigger worry than
  // sparks. kids don't know about sparks."
  //
  // A silent edit the child never asked for, which can delete their work, is
  // not a performance feature. The tap-to-fix banner (every test above) is a
  // different path and stays.
  const heavy = { docKey: "d1", lastAutoFixedDocKey: null, models: [], drawCalls: 900, busy: false };

  it("never fires, however draw-call-bound the scene is", () => {
    expect(AUTO_FIX_ENABLED).toBe(false);
    expect(shouldAutoFixSlowdown({ ...heavy, autoFixCount: 0 })).toBe(false);
    expect(shouldAutoFixSlowdown({ ...heavy, drawCalls: 99_999, autoFixCount: 0 })).toBe(false);
  });
});

describe("the bounds underneath it, kept honest while it is off", () => {
  // These pin autoFixBoundsAllow directly, so if the owner turns the switch
  // back on it cannot return unbounded — the loop that started this is
  // impossible either way.
  const heavy = { docKey: "d1", lastAutoFixedDocKey: null, models: [], drawCalls: 900, busy: false };

  it("would allow the first fix", () => {
    expect(autoFixBoundsAllow({ ...heavy, autoFixCount: 0 })).toBe(true);
  });

  it("stops after the session cap, even on a brand-new docKey", () => {
    // The actual defect: every successful fix mints a new docKey, so the
    // per-docKey guard reset itself and the fix fired again, and again.
    expect(
      autoFixBoundsAllow({ ...heavy, docKey: "d9", autoFixCount: MAX_AUTO_FIXES_PER_SESSION }),
    ).toBe(false);
  });

  it("stops when the previous fix did NOT reduce draw calls", () => {
    expect(
      autoFixBoundsAllow({ ...heavy, docKey: "d2", autoFixCount: 1, drawCalls: 880, lastAutoFixDrawCalls: 900 }),
    ).toBe(false);
  });

  it("allows a second attempt when the first genuinely helped but it is still heavy", () => {
    expect(
      autoFixBoundsAllow({ ...heavy, docKey: "d2", autoFixCount: 1, drawCalls: 500, lastAutoFixDrawCalls: 900 }),
    ).toBe(true);
  });

  it("still never fires while a turn is streaming", () => {
    expect(autoFixBoundsAllow({ ...heavy, busy: true, autoFixCount: 0 })).toBe(false);
  });
});
