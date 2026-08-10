// Kid-facing "running slow" banner (docs/2026-07-30_PRD_PreviewPerfPanel.md
// addendum, 2026-07-30). The debug Perf tab (lib/assets/perf-probe.ts,
// ArtifactFrame.tsx's "perf" tab) is for admins and shows the real per-model
// breakdown — triangles, instance counts, raw model asset names ("grandpa",
// "fielder"). A kid does not know what any of that means. What a kid DOES
// recognize is the symptom: the game feels stuck, not smooth. So this is a
// second, always-visible (no debug flag) surface that shows ONLY that
// symptom plus one button — "Make it faster" — which sends a technically
// precise fix request into chat on the kid's behalf, without ever showing
// the kid the technical text.
//
// Framework-free, same house style as idea-mic.ts / stuck-signal.ts: pure
// functions the React layer (ArtifactFrame.tsx) just wires events into.

import type { PerfModelEntry } from "@/types/preview-perf.types";

/** FPS below this counts as "low" for one sample. Roughly half of a smooth
 *  60fps target — comfortably below the range where a kid would notice
 *  stutter, so we don't nag over a normal, playable game. */
export const LOW_FPS_THRESHOLD = 30;

/** How many CONSECUTIVE low-fps samples (one per perf-probe.ts's
 *  PERF_SAMPLE_MS, ~1s each) before the banner shows. This is the debounce:
 *  a single dipped frame (a GC pause, a one-off hitch) must never flap the
 *  banner on/off — only a genuinely sustained slowdown does. */
export const SUSTAINED_LOW_SAMPLES = 5;

/** After the kid taps "Make it faster", how long the banner stays hidden
 *  even if FPS is still low — the fix request is presumably in flight
 *  (a new game build takes real time), so re-showing immediately would
 *  read as the button having done nothing. */
export const COOLDOWN_MS = 45_000;

export interface SlowdownBannerState {
  visible: boolean;
  /** Consecutive low-fps samples seen so far, reset by any healthy sample. */
  consecutiveLow: number;
  /** Epoch ms until which the banner is suppressed regardless of FPS, or
   *  null when no cooldown is active. */
  cooldownUntil: number | null;
}

export const initialSlowdownBannerState: SlowdownBannerState = {
  visible: false,
  consecutiveLow: 0,
  cooldownUntil: null,
};

export type SlowdownBannerEvent =
  /** One perf-probe snapshot arrived — `fps` is that sample's reading.
   *  `playing` (probe v3, owner report 2026-08-06): frames were actually
   *  being produced AND the kid touched the game recently. An unstarted
   *  game, an idle multiplayer lobby, or the frame governor's deliberate
   *  idling all read as near-zero fps — that is "not running", not "running
   *  slow", and must never satisfy the sustained-low rule. Omitted (old
   *  cached probe) → treated as playing, the pre-v3 behavior. */
  | { type: "sample"; fps: number; now: number; playing?: boolean }
  /** The kid tapped "Make it faster". */
  | { type: "fixTapped"; now: number }
  /** A new game / generation — docKey changed, so any half-accumulated
   *  streak or cooldown from the PREVIOUS game must never leak forward. */
  | { type: "reset" };

export function nextSlowdownBannerState(
  state: SlowdownBannerState,
  event: SlowdownBannerEvent,
): SlowdownBannerState {
  switch (event.type) {
    case "reset":
      return { ...initialSlowdownBannerState };

    case "fixTapped":
      return { visible: false, consecutiveLow: 0, cooldownUntil: event.now + COOLDOWN_MS };

    case "sample": {
      // Still cooling down from a recent tap: stay hidden and don't even
      // accumulate a streak, so the banner can't pop back the instant the
      // cooldown ends on a game that's still genuinely slow — it needs a
      // fresh sustained run after the clock is clear (see the "cooldown
      // elapsed" branch below, which starts counting from THIS sample).
      if (state.cooldownUntil !== null && event.now < state.cooldownUntil) {
        return { visible: false, consecutiveLow: 0, cooldownUntil: state.cooldownUntil };
      }
      // Not playing (owner report 2026-08-06): low fps while the game isn't
      // producing frames / being touched is expected, not a symptom — drop
      // the streak, but leave an already-visible banner up (the kid stopping
      // to READ the banner is itself "not playing").
      if (event.playing === false) {
        return { ...state, consecutiveLow: 0, cooldownUntil: null };
      }
      const consecutiveLow = event.fps < LOW_FPS_THRESHOLD ? state.consecutiveLow + 1 : 0;
      return {
        visible: consecutiveLow >= SUSTAINED_LOW_SAMPLES,
        consecutiveLow,
        cooldownUntil: null, // any cooldown has elapsed by construction above
      };
    }
  }
}

/**
 * The REAL technical fix request sent into chat when the kid taps
 * "Make it faster" — built from the latest PerfSnapshot's model list
 * (already available to ArtifactFrame via usePerfProbe). The kid never sees
 * this string; it rides straight into the same handleSend pipeline as any
 * other chat turn, so the AI gets a genuinely targeted, in-scope ask.
 *
 * Deliberately mirrors the debug Perf tab's own ranking (highest `load`
 * first) but never repeats a raw number a kid wouldn't recognize (no
 * triangle counts) — instances and animated state are enough for the model
 * to act on.
 */
/** The single worst-load model in the current scene, or null for a scene
 *  with nothing tracked (e.g. a pure 2D game). Defensive re-sort — never
 *  trusts the caller already sorted (PerfSnapshot.models normally is, but
 *  this is the one place a stale/hand-built list would silently pick the
 *  wrong offender). Shared by buildSlowdownHint (the kid-facing fix request)
 *  and perf-report.ts (the server-log payload) so the two can never disagree
 *  about which model is "the heaviest one" for the same snapshot. */
export function heaviestModel(models: PerfModelEntry[]): PerfModelEntry | null {
  return [...models].sort((a, b) => b.load - a.load)[0] ?? null;
}

/** Draw calls per frame above which the scene's mesh COUNT — not any single
 *  model — is the dominant cost. Calibrated on the 2026-08-10 AutoRicksaw
 *  profile: 1,250 draws/frame = 37ms of per-mesh JS = 20fps with a trivial
 *  15k triangles; healthy generated games sit well under 150. */
export const HIGH_DRAW_CALLS_THRESHOLD = 300;

export function buildSlowdownHint(models: PerfModelEntry[], drawCalls?: number | null): string {
  const heaviest = heaviestModel(models);
  // High draw calls with no genuinely heavy model: the cost is thousands of
  // hand-built meshes the model accounting can't see. Naming the heaviest
  // tracked model here sends the fix after the wrong target — the owner's
  // AutoRicksaw chat did exactly that NINE times ("the tree, 2 instances")
  // while the real problem was per-floor window meshes.
  const drawBound =
    typeof drawCalls === "number" &&
    drawCalls > HIGH_DRAW_CALLS_THRESHOLD &&
    (!heaviest || heaviest.bucket === "green");
  if (drawBound) {
    return (
      `The game is running slow because the scene draws about ${drawCalls} separate ` +
      "objects every frame. Merge repeated things: for hand-built shapes use one " +
      "InstancedMesh (import it from \"three\") per repeated object type — building " +
      "pieces, windows, coins, scenery — placing each copy with " +
      "setMatrixAt(i, new Matrix4().setPosition(x, y, z)); for " +
      "repeated 3D models use the loadModelBatch(name, count) helper that already " +
      "exists as a global function (never import it). Reuse shared geometries and " +
      "materials, aiming for under 150 draw calls, without changing what the game " +
      "is about."
    );
  }
  if (!heaviest) {
    return (
      "The game is running slow. Find ways to reduce how much work happens " +
      "every frame — fewer things on screen at once, simpler visuals, or " +
      "less constant animation — without changing what the game is about."
    );
  }
  const countPhrase = heaviest.instances === 1 ? "1 instance" : `${heaviest.instances} instances`;
  const animPhrase = heaviest.animated ? ", animated" : "";
  return (
    `The game is running slow. The heaviest thing in the scene right now is ` +
    `the '${heaviest.name}' model (${countPhrase}${animPhrase}). Reduce its ` +
    `cost — fewer instances, remove animation, or a simpler version — ` +
    `without changing what the game is about.`
  );
}
