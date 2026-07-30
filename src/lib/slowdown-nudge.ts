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
  /** One perf-probe snapshot arrived — `fps` is that sample's reading. */
  | { type: "sample"; fps: number; now: number }
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
export function buildSlowdownHint(models: PerfModelEntry[]): string {
  const heaviest = [...models].sort((a, b) => b.load - a.load)[0];
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
