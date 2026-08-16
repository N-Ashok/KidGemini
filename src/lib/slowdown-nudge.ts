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

/** True when the scene's draw-call COUNT, not any single tracked model, is
 *  the dominant cost — the case `buildSlowdownHint` and the proactive
 *  auto-fix trigger (below) must both recognize the same way, so they can
 *  never disagree about which fix a given snapshot calls for. */
export function isDrawCallBound(models: PerfModelEntry[], drawCalls?: number | null): boolean {
  const heaviest = heaviestModel(models);
  // High draw calls with no genuinely heavy model: the cost is thousands of
  // hand-built meshes the model accounting can't see. Naming the heaviest
  // tracked model here sends the fix after the wrong target — the owner's
  // AutoRicksaw chat did exactly that NINE times ("the tree, 2 instances")
  // while the real problem was per-floor window meshes.
  return (
    typeof drawCalls === "number" &&
    drawCalls > HIGH_DRAW_CALLS_THRESHOLD &&
    (!heaviest || heaviest.bucket === "green")
  );
}

export function buildSlowdownHint(models: PerfModelEntry[], drawCalls?: number | null): string {
  const heaviest = heaviestModel(models);
  if (isDrawCallBound(models, drawCalls)) {
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

/**
 * Proactive draw-call nudge (owner decision 2026-08-10): the tap-based flow
 * above waits for FIVE CONSECUTIVE low-fps samples while the kid is actually
 * playing — real for AutoRicksaw's kind of slowdown too, but it means a scene
 * that's already draw-call-bound the moment an edit lands sits there until
 * gameplay happens to surface it (or never, if the kid never taps back in).
 * `shouldAutoFixSlowdown` fires the SAME instant a fresh snapshot shows the
 * scene is draw-call-bound, independent of fps/play state — one-shot per
 * docKey (a fix attempt changes the document, giving a new docKey to re-check
 * against; a soft-failed patch leaves docKey unchanged, so this can only ever
 * fire once per actual document, never loop).
 */
export function shouldAutoFixSlowdown(args: AutoFixArgs): boolean {
  // OFF (2026-08-16, owner report). See AUTO_FIX_ENABLED.
  if (!AUTO_FIX_ENABLED) return false;
  return autoFixBoundsAllow(args);
}

export interface AutoFixArgs {
  docKey: string;
  lastAutoFixedDocKey: string | null;
  models: PerfModelEntry[];
  drawCalls?: number | null;
  /** A real edit is already streaming (handleSend has no concurrency guard
   *  of its own — production incident 2026-08-11: the silent auto-fix turn
   *  fired WHILE the kid's own edit was mid-stream, two concurrent
   *  runStream() calls against the same conversation raced the artifact/
   *  docKey update mid-generation and left the preview's WebGL context
   *  stuck — only a forced iframe remount, e.g. Code tab and back,
   *  recovered it). Must stay false while busy — the caller does NOT
   *  advance `lastAutoFixedDocKey` on a false return, so this retries on
   *  the next snapshot once the kid's turn finishes, rather than being
   *  silently skipped forever for this docKey. */
  busy: boolean;
  /** How many auto-fixes this conversation has already spent. */
  autoFixCount?: number;
  /** Draw calls measured when the LAST auto-fix fired, so we can tell whether
   *  it actually helped. */
  lastAutoFixDrawCalls?: number | null;
}

/**
 * The bounds themselves, kept separate from the master switch so they stay
 * exercised and honest while the switch is off — if the owner turns the
 * proactive fix back on, it can never come back unbounded.
 */
export function autoFixBoundsAllow(args: AutoFixArgs): boolean {
  // WHY THE SWITCH ABOVE IS OFF (2026-08-16, owner report). Bounding the loop
  // was not enough. Owner, after the repeated "I've tidied up the village" turns: "it broke the whole
  // game. all the meshes were gone. that was bigger worry than sparks. kids
  // don't know about sparks."
  //
  // That is the real cost. This path sends a SILENT model edit — the child did
  // not ask for it, does not see it coming, and cannot connect the result to
  // anything they did. When it goes wrong it takes their game with it, and a
  // child has no way to say "undo the thing I never asked for". Two such edits
  // are not meaningfully safer than five. An unasked-for edit that can delete a
  // child's work is not a performance feature.
  //
  // What survives: the "Make it faster" BANNER, which the child taps. Same fix
  // request, same hint text — but they chose it, they watch it happen, and the
  // result belongs to them. That flow is untouched.
  //
  // Reversible in one line if the owner wants it back, and the bounds below
  // stay in place and tested underneath it so it never returns unbounded.
  if (args.busy) return false;
  if (args.docKey === args.lastAutoFixedDocKey) return false;
  if (!isDrawCallBound(args.models, args.drawCalls)) return false;

  // BOUND THE LOOP (2026-08-16). The per-docKey guard above stops a tight
  // retry on ONE document, but every successful fix mints a NEW docKey — so
  // the guard resets and this can fire again, and again. Owner, watching a
  // child play in production: "I've tidied up the way the village is built so
  // your race zooms along even faster than before! — this kept appearing as i
  // was riding the car". Each appearance is a real model turn: it interrupts
  // her game, edits it under her, and spends Sparks.
  const spent = args.autoFixCount ?? 0;
  if (spent >= MAX_AUTO_FIXES_PER_SESSION) return false;

  // And stop if the last attempt did not actually help. Same principle the
  // resolution governor uses: the premise ("cutting draw calls will fix this")
  // is measured, not assumed. If draw calls did not fall meaningfully after
  // the previous fix, this scene is not going to be fixed by asking again.
  const before = args.lastAutoFixDrawCalls;
  const now = args.drawCalls;
  if (typeof before === "number" && typeof now === "number" && now > before * AUTO_FIX_MUST_HELP_RATIO) {
    return false;
  }
  return true;
}

/** Master switch for the PROACTIVE, silent auto-fix (the one the child never
 *  asked for). Off since 2026-08-16: it deleted every mesh from a child's game
 *  mid-play. The child-tapped "Make it faster" banner is a different path and
 *  is unaffected by this flag. */
export const AUTO_FIX_ENABLED = false;

/** Two attempts per conversation. The first is usually right; a third has
 *  never been the difference between a playable game and an unplayable one,
 *  and each one takes the game away from the child mid-play. */
export const MAX_AUTO_FIXES_PER_SESSION = 2;

/** A follow-up fix must have left draw calls at least 10% lower than the one
 *  before it, or we stop trying. */
export const AUTO_FIX_MUST_HELP_RATIO = 0.9;

/**
 * The chat turn sent when `shouldAutoFixSlowdown` fires — the SAME technical
 * ask as `buildSlowdownHint`'s draw-call branch, plus one instruction the
 * tap flow doesn't need: nothing typed this, so the model must say so itself
 * in plain, kid-friendly words instead of silently just returning code.
 * `handleSend`'s caller marks this turn `silent` (no child bubble rendered)
 * so the ONLY visible trace is that one sentence, not a fake typed request.
 */
export function buildAutoFixHint(models: PerfModelEntry[], drawCalls?: number | null): string {
  return (
    `${buildSlowdownHint(models, drawCalls)} The child did not ask for this — ` +
    "you noticed it yourself right after the last change. After applying the " +
    "fix, reply with exactly ONE short, friendly sentence (no numbers, no " +
    "technical terms) telling them their game runs smoother now, and nothing else."
  );
}
