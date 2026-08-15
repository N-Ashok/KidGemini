// Verify/repair state machine — including the REGRESSION for BUG-FIX-LOG
// 2026-07-10 "repair stuck on Fixing…": the React-effect version cancelled
// its own repair continuation on the phase transition, dropping the server's
// successful patch and leaving the cover up forever.
import { describe, it, expect, vi } from "vitest";
import { PreviewVerifyController, ROUND_HARD_TIMEOUT_MS } from "./preview-verify-controller";
import type { VerifyControllerState } from "./preview-verify-controller";
import type { RepairResponse, VerifyEvidence } from "@/types/preview-verify.types";
import { WALL_CLOCK_CAP_MS } from "./verify-policy";
import { GAME_CONSOLE_SOURCE, PREVIEW_VERIFY_SOURCE } from "./preview-messages";

const RESULT = (over: Partial<VerifyEvidence> = {}) => ({
  source: PREVIEW_VERIFY_SOURCE,
  event: {
    type: "result",
    evidence: {
      rafCountAtSettle: 0,
      rafCountFinal: 0,
      canvas: null,
      pixel: null,
      start: { found: false },
      ...over,
    },
  },
});

const CLEAN_RESULT = RESULT({ rafCountAtSettle: 5, rafCountFinal: 12, pixel: "changing", start: null });

/** A load-time throw — a hard-evidence (repairable) failure class. */
const LOAD_ERROR = {
  source: GAME_CONSOLE_SOURCE,
  message: {
    level: "error",
    kind: "error",
    text: "TypeError: boom (g.html:2:1)",
    filename: "g.html",
    line: 2,
    stack: "TypeError: boom\n at g.html:2:1",
  },
};

function harness(opts: {
  repair?: (n: number) => RepairResponse | Promise<RepairResponse>;
  repairEnabled?: boolean;
}) {
  const states: VerifyControllerState[] = [];
  const events: Array<{ name: string; props: Record<string, unknown> }> = [];
  let clock = 1_000;
  let repairCalls = 0;
  const timers: Array<() => void> = [];
  const controller = new PreviewVerifyController({
    fetchRepair: async () => {
      repairCalls++;
      const r = opts.repair?.(repairCalls);
      if (!r) throw new Error("network");
      return r;
    },
    track: (name, props) => events.push({ name, props }),
    now: () => clock,
    setTimeout: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout: () => {},
    repairEnabled: opts.repairEnabled ?? true,
    onChange: (s) => states.push(s),
  });
  return {
    controller,
    states,
    events,
    timers,
    last: () => states[states.length - 1]!,
    advance: (ms: number) => {
      clock += ms;
    },
    repairCalls: () => repairCalls,
  };
}

// Let queued microtasks (the async settle continuation) run.
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("PreviewVerifyController — repair continuation (the stuck-Fixing regression)", () => {
  it("applies the server's patch after its OWN phase transition to repairing", async () => {
    const h = harness({
      repair: () => ({ patchedHtml: "<html>patched</html>", mode: "patch" }),
    });
    h.controller.start("<html>broken</html>", "a snake game", false);
    expect(h.last().phase).toBe("testing");

    h.controller.handleMessage(LOAD_ERROR);
    h.controller.handleMessage(RESULT()); // load_error → repair
    // The transition to "repairing" (state emit) must NOT cancel the flow —
    // this is exactly where the effect-based version dropped the patch.
    expect(h.last().phase).toBe("repairing");
    expect(h.last().kidLine).toContain("Fixing");
    await flush();

    const s = h.last();
    expect(s.phase).toBe("testing"); // NEW round on the patched html
    expect(s.currentHtml).toBe("<html>patched</html>");
    expect(s.round).toBe(2);
    expect(h.repairCalls()).toBe(1);
  });

  it("patched html that verifies clean finishes as outcome:repaired", async () => {
    const h = harness({ repair: () => ({ patchedHtml: "<html>patched</html>", mode: "patch" }) });
    h.controller.start("<html>broken</html>", "a game", false);
    h.controller.handleMessage(LOAD_ERROR);
    h.controller.handleMessage(RESULT());
    await flush();
    h.controller.handleMessage(CLEAN_RESULT); // round 2 verifies clean
    await flush();
    expect(h.last().phase).toBe("done");
    expect(h.last().outcome).toBe("repaired");
    expect(h.last().question).toBeNull();
    expect(h.events.find((e) => e.name === "preview_verify")?.props.outcome).toBe("repaired");
  });

  it("R.2 — caps at 2 attempts, then uncovers the best version with a question", async () => {
    const h = harness({ repair: (n) => ({ patchedHtml: `<html>patch${n}</html>`, mode: "patch" }) });
    h.controller.start("<html>broken</html>", "a game", false);
    h.controller.handleMessage(LOAD_ERROR);
    h.controller.handleMessage(RESULT()); // fail 1 → repair 1
    await flush();
    h.controller.handleMessage(LOAD_ERROR);
    h.controller.handleMessage(RESULT()); // fail 2 → repair 2
    await flush();
    h.controller.handleMessage(LOAD_ERROR);
    h.controller.handleMessage(RESULT()); // fail 3 → exhausted
    await flush();
    expect(h.repairCalls()).toBe(2); // a third is never issued
    const s = h.last();
    expect(s.phase).toBe("done");
    expect(s.outcome).toBe("failed");
    expect(s.question).toBeTruthy();
    expect(s.question!.toLowerCase()).not.toContain("stack");
  });

  it("R.3 — past the 20s wall clock it bails without another repair", async () => {
    const h = harness({ repair: () => ({ patchedHtml: "<html>p</html>", mode: "patch" }) });
    h.controller.start("<html>broken</html>", "a game", false);
    h.advance(WALL_CLOCK_CAP_MS + 1);
    h.controller.handleMessage(RESULT());
    await flush();
    expect(h.repairCalls()).toBe(0);
    expect(h.last().outcome).toBe("bailed");
  });

  it("a failed/erroring repair call finishes as outcome:failed (no infinite spinner)", async () => {
    const h = harness({}); // fetchRepair throws
    h.controller.start("<html>broken</html>", "a game", false);
    h.controller.handleMessage(LOAD_ERROR);
    h.controller.handleMessage(RESULT());
    await flush();
    expect(h.last().phase).toBe("done");
    expect(h.last().outcome).toBe("failed");
    expect(h.events.find((e) => e.name === "preview_repair")?.props.success).toBe(false);
  });

  // REGRESSION (BUG-FIX-LOG 2026-07-20, owner UAT on prod): a game running
  // and drawing fine, but a benign unhandled rejection (audio autoplay is the
  // archetype) classified async_loop → 2 Gemini "repairs" of a healthy game →
  // "Oops — fixing it" → give-up banner + a drifted/stale document. A
  // demonstrably-running game must pass through with NO repair spend.
  it("benign error on a demonstrably-running game: no repair, no Oops, no question", async () => {
    const h = harness({ repair: () => ({ patchedHtml: "<html>mangled</html>", mode: "patch" }) });
    h.controller.start("<html>healthy but noisy</html>", "a game", false);
    h.controller.handleMessage({
      source: GAME_CONSOLE_SOURCE,
      message: { level: "error", kind: "rejection", text: "Unhandled promise rejection: NotAllowedError: play() failed", stack: "" },
    });
    h.controller.handleMessage(CLEAN_RESULT); // loop running, pixels changing
    await flush();
    expect(h.repairCalls()).toBe(0); // never spent a Gemini call
    expect(h.states.every((s) => s.phase !== "repairing")).toBe(true); // no Oops line
    const s = h.last();
    expect(s.phase).toBe("done");
    expect(s.question).toBeNull();
    expect(s.currentHtml).toBe("<html>healthy but noisy</html>"); // untouched
  });

  it("probe-inference codes pass through SILENTLY — no repair call, no question (false-repair UAT)", async () => {
    const h = harness({ repair: () => ({ patchedHtml: "<html>p</html>", mode: "patch" }) });
    h.controller.start("<html>maybe fine</html>", "a game", false);
    // canvas_static read: loop runs, pixels static, no start control found.
    h.controller.handleMessage(RESULT({ rafCountAtSettle: 4, canvas: { width: 300, height: 200 }, pixel: "static" }));
    await flush();
    const s = h.last();
    expect(h.repairCalls()).toBe(0); // no Gemini spend on a probably-healthy game
    expect(s.phase).toBe("done");
    expect(s.question).toBeNull(); // uncovers silently
    expect(s.currentHtml).toBe("<html>maybe fine</html>"); // untouched
    expect(h.events.find((e) => e.name === "preview_verify")?.props.failure_code).toBe("canvas_static");
  });
});

describe("PreviewVerifyController — probe-click reload & guards", () => {
  it("clean via a probe-clicked Start reloads the iframe with probes DISABLED", async () => {
    const h = harness({});
    h.controller.start("<html>title screen</html>", "a game", false);
    expect(h.last().probesEnabled).toBe(true);
    h.controller.handleMessage(
      RESULT({ rafCountAtSettle: 0, start: { found: true, x: 1, y: 1, occluded: false, clickRafDelta: 3 } }),
    );
    await flush();
    const s = h.last();
    expect(s.phase).toBe("done");
    expect(s.outcome).toBe("clean");
    expect(s.round).toBe(2); // reload…
    expect(s.probesEnabled).toBe(false); // …but nothing ghost-clicks Start again
  });

  it("clean with no probe click does NOT reload (no flash)", async () => {
    const h = harness({});
    h.controller.start("<html>game</html>", "a game", false);
    h.controller.handleMessage(CLEAN_RESULT);
    await flush();
    expect(h.last().round).toBe(1);
    expect(h.last().outcome).toBe("clean");
  });

  it("V.10 — document hidden at start skips verify entirely", () => {
    const h = harness({});
    h.controller.start("<html>game</html>", "a game", true);
    expect(h.last().phase).toBe("done");
    expect(h.last().outcome).toBe("skipped");
    expect(h.last().probesEnabled).toBe(false);
  });

  // BUG-FIX-LOG 2026-08-13: a skipped verify (tab backgrounded at generation
  // time, e.g. a long 3D build) never got a second chance — the owner had to
  // notice a broken game themselves and paste a manual error report. Once the
  // tab comes back into view, a real round can safely run (rAF ticks again).
  it("retryIfSkipped starts a real round once the tab is visible again after a skip", () => {
    const h = harness({});
    h.controller.start("<html>game</html>", "a game", true);
    expect(h.last().outcome).toBe("skipped");

    h.controller.retryIfSkipped("<html>game</html>");
    expect(h.last().phase).toBe("testing");
    expect(h.last().probesEnabled).toBe(true);
    expect(h.last().outcome).toBe(null); // no longer "skipped" — a real round is running
  });

  it("retryIfSkipped is a no-op when the last outcome wasn't a skip (never double-verifies)", async () => {
    const h = harness({});
    h.controller.start("<html>game</html>", "a game", false);
    h.controller.handleMessage(CLEAN_RESULT);
    await flush();
    expect(h.last().outcome).toBe("clean");
    const before = h.last();

    h.controller.retryIfSkipped("<html>game</html>");
    expect(h.last()).toBe(before); // unchanged — no new round, no re-verify
  });

  it("V.11 — interrupted (tab backgrounded) no-loop reads pass through, no repair", async () => {
    const h = harness({ repair: () => ({ patchedHtml: "<html>p</html>", mode: "patch" }) });
    h.controller.start("<html>game</html>", "a game", false);
    h.controller.markInterrupted();
    h.controller.handleMessage(RESULT());
    await flush();
    expect(h.repairCalls()).toBe(0);
    expect(h.last().outcome).toBe("clean");
  });

  it("hard timeout with no probe report settles inconclusive — never a stuck cover", async () => {
    const h = harness({});
    h.controller.start("<html>game</html>", "a game", false);
    expect(h.timers.length).toBe(1);
    void h.timers[0]!(); // ROUND_HARD_TIMEOUT_MS fires, no evidence arrived
    await flush();
    expect(h.last().phase).toBe("done");
    expect(h.last().outcome).toBe("clean"); // inconclusive → pass through
    expect(ROUND_HARD_TIMEOUT_MS).toBeLessThan(WALL_CLOCK_CAP_MS);
  });

  // REGRESSION (BUG-FIX-LOG 2026-07-20, "non-playable until the panel is
  // reopened"): the probe ghost-clicks Start, but only the CLEAN finish path
  // consulted the click when deciding the pristine reload. Every other finish
  // (telemetry pass-through, lost-evidence timeout, failed repair) uncovered
  // the already-started document — the kid landed mid-game/game-over with no
  // start screen. Any finish after a click must reload with probes off.
  it("telemetry pass-through AFTER a probe click still reloads pristine (canvas_static)", async () => {
    const h = harness({});
    h.controller.start("<html>slow first frame</html>", "a game", false);
    // Loop runs, pixels static, Start found+clicked, still static after click.
    h.controller.handleMessage(
      RESULT({
        rafCountAtSettle: 4,
        canvas: { width: 300, height: 200 },
        pixel: "static",
        pixelAfterClick: "static",
        start: { found: true, x: 1, y: 1, occluded: false, clickRafDelta: 0 },
      }),
    );
    await flush();
    const s = h.last();
    expect(s.phase).toBe("done");
    expect(s.question).toBeNull(); // still a silent pass-through…
    expect(s.round).toBe(2); // …but the ghost-clicked document reloads
    expect(s.probesEnabled).toBe(false);
  });

  it("hard timeout after the probe ANNOUNCED its click (result lost) still reloads pristine", async () => {
    const h = harness({});
    h.controller.start("<html>game</html>", "a game", false);
    h.controller.handleMessage({ source: PREVIEW_VERIFY_SOURCE, event: { type: "clicked" } });
    void h.timers[0]!(); // hard timeout — the result evidence never arrived
    await flush();
    const s = h.last();
    expect(s.outcome).toBe("clean"); // inconclusive → pass through, as before
    expect(s.round).toBe(2); // but the click means: pristine reload
    expect(s.probesEnabled).toBe(false);
  });

  it("failed repair after a probe click reloads even when the best version IS the current one", async () => {
    const h = harness({}); // fetchRepair throws
    h.controller.start("<html>broken</html>", "a game", false);
    h.controller.handleMessage(LOAD_ERROR);
    h.controller.handleMessage(
      RESULT({ start: { found: true, x: 1, y: 1, occluded: false, clickRafDelta: 0 } }),
    );
    await flush();
    const s = h.last();
    expect(s.phase).toBe("done");
    expect(s.outcome).toBe("failed");
    expect(s.currentHtml).toBe("<html>broken</html>"); // best === current
    expect(s.round).toBe(2); // clicked → reload anyway
  });

  it("dispose() drops a late repair result instead of emitting into a dead UI", async () => {
    let resolve!: (r: RepairResponse) => void;
    const h = harness({ repair: () => new Promise<RepairResponse>((r) => (resolve = r)) });
    h.controller.start("<html>broken</html>", "a game", false);
    h.controller.handleMessage(LOAD_ERROR);
    h.controller.handleMessage(RESULT());
    await flush(); // let settle() reach the pending fetchRepair
    const emitted = h.states.length;
    h.controller.dispose(); // kid closed the panel / sent a new message
    resolve({ patchedHtml: "<html>late</html>", mode: "patch" });
    await flush();
    expect(h.states.length).toBe(emitted); // nothing emitted after dispose
  });
});

describe("healMidPlay — repairing the game the child is already playing (2026-08-15)", () => {
  // Owner: "when there is an error the browser should automatically push to
  // Ari and solve it. now more than ever, i see error reports [and broken
  // games]." The heal only ever covered the load window: handleMessage drops
  // everything once settled, so a mid-play throw reached nothing.
  const settledHarness = async () => {
    const h = harness({ repair: () => ({ patchedHtml: "<html>fixed</html>", mode: "patch" }) });
    h.controller.start("<html>playing</html>", "a snake game", false);
    h.controller.handleMessage(RESULT({ rafCountAtSettle: 10, pixel: "changing" }));
    await flush();
    return h;
  };

  it("swaps the fixed game in and reloads the iframe", async () => {
    const h = await settledHarness();
    const roundBefore = h.last().round;
    const attempted = await h.controller.healMidPlay([LOAD_ERROR.message as never]);
    expect(attempted).toBe(true);
    expect(h.last().currentHtml).toBe("<html>fixed</html>");
    // A round bump is what reloads the iframe with the fixed document.
    expect(h.last().round).toBe(roundBefore + 1);
    // Probes stay OFF so nothing ghost-clicks the child's own controls.
    expect(h.last().probesEnabled).toBe(false);
    expect(h.last().outcome).toBe("repaired");
  });

  it("shows a kid-facing line while it works, and clears it after", async () => {
    const h = await settledHarness();
    await h.controller.healMidPlay([LOAD_ERROR.message as never]);
    expect(h.states.some((s) => (s.kidLine ?? "").includes("Fixing"))).toBe(true);
    expect(h.last().kidLine).toBeNull();
  });

  it("leaves the game EXACTLY as it was when the repair fails", async () => {
    // The whole risk of touching a document someone is playing: a failed heal
    // must never take their game away.
    const h = harness({}); // fetchRepair throws
    h.controller.start("<html>playing</html>", "a snake game", false);
    h.controller.handleMessage(RESULT({ rafCountAtSettle: 10, pixel: "changing" }));
    await flush();
    const before = h.last().currentHtml;
    const roundBefore = h.last().round;
    await h.controller.healMidPlay([LOAD_ERROR.message as never]);
    expect(h.last().currentHtml).toBe(before);
    expect(h.last().round).toBe(roundBefore);
    expect(h.last().kidLine).toBeNull();
  });

  it("does nothing before verify has settled — that window has its own loop", async () => {
    const h = harness({ repair: () => ({ patchedHtml: "<html>fixed</html>", mode: "patch" }) });
    h.controller.start("<html>playing</html>", "a snake game", false);
    const attempted = await h.controller.healMidPlay([LOAD_ERROR.message as never]);
    expect(attempted).toBe(false);
    expect(h.repairCalls()).toBe(0);
  });

  it("does nothing with no errors, and nothing when repair is disabled", async () => {
    const h = await settledHarness();
    expect(await h.controller.healMidPlay([])).toBe(false);

    const off = harness({ repairEnabled: false, repair: () => ({ patchedHtml: "<html>x</html>", mode: "patch" }) });
    off.controller.start("<html>playing</html>", "a game", false);
    off.controller.handleMessage(RESULT({ rafCountAtSettle: 10, pixel: "changing" }));
    await flush();
    expect(await off.controller.healMidPlay([LOAD_ERROR.message as never])).toBe(false);
    expect(off.repairCalls()).toBe(0);
  });
});
