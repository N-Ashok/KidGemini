// Self-healing preview — the verify/repair state machine, framework-free.
//
// WHY THIS EXISTS (BUG-FIX-LOG 2026-07-10 "repair stuck on Fixing…"): the
// first implementation ran this flow inside a React effect whose dependency
// array included `phase`. The hook's OWN transition to "repairing" re-ran the
// effect, the cleanup set the round's cancelled flag, and the in-flight
// repair continuation dropped the server's patch — the kid stared at a
// bouncing 🔧 forever while /api/repair had already succeeded. State machines
// don't belong in effect closures: this class owns the flow, is fully
// unit-testable in node (deps injected), and usePreviewVerify is now a thin
// adapter that only wires browser events in and state out.

import type { GameConsoleMessage } from "@/types/game-console.types";
import type {
  RepairRequest,
  RepairResponse,
  VerifyCheckId,
  VerifyEvidence,
  VerifyOutcome,
  VerifyScriptEvent,
} from "@/types/preview-verify.types";
import { classifyVerify, demonstrablyRunning, CLICK_WAIT_MS, PIXEL_WINDOW_MS, SETTLE_MS } from "./preview-verify";
import { REPAIR_TAXONOMY, SECOND_ATTEMPT_LINE, exhaustedQuestion } from "./repair-prompt";
import { WALL_CLOCK_CAP_MS, shouldRepair, verifyOutcome } from "./verify-policy";
import { GAME_CONSOLE_SOURCE, PREVIEW_VERIFY_SOURCE } from "./preview-messages";

/** If the probe script never reports (game clobbered postMessage, document
 *  crashed, iframe unmounted), stop waiting and pass through — a stuck cover
 *  screen is the §8.4 failure mode to fear. */
export const ROUND_HARD_TIMEOUT_MS = SETTLE_MS + PIXEL_WINDOW_MS + CLICK_WAIT_MS + 6_000;

export interface VerifyControllerState {
  phase: "testing" | "repairing" | "done";
  /** The HTML the iframe should render — the repaired version once a patch lands. */
  currentHtml: string;
  /** Increments per verify round — part of the iframe key so an identical
   *  patched document still remounts. */
  round: number;
  /** Whether the CURRENT iframe document should run probes. False after a
   *  clean finish — the post-verify reload must not ghost-click Start. */
  probesEnabled: boolean;
  checks: Array<{ check: VerifyCheckId; ok: boolean }>;
  /** §8.3 State-3 line while a repair is in flight. */
  kidLine: string | null;
  /** §9.1 question when repair is exhausted/bailed — never a stack trace. */
  question: string | null;
  outcome: VerifyOutcome | null;
}

export interface VerifyControllerDeps {
  fetchRepair: (req: RepairRequest) => Promise<RepairResponse>;
  track: (
    name: "preview_verify" | "preview_repair",
    props: Record<string, string | number | boolean | null>,
  ) => void;
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (t: unknown) => void;
  repairEnabled: boolean;
  onChange: (state: VerifyControllerState) => void;
}

export class PreviewVerifyController {
  private readonly deps: VerifyControllerDeps;
  private state: VerifyControllerState;
  private originalRequest = "";
  private t0 = 0;
  private attempt = 0;
  private interrupted = false;
  private disposed = false;
  private versions: Array<{ html: string; severity: number }> = [];
  // Per-round capture:
  private errors: GameConsoleMessage[] = [];
  private evidence: VerifyEvidence | null = null;
  /** The probe announced a ghost-click on Start this round (its own event,
   *  sent before the click — survives a lost result). A clicked document is
   *  running/started behind the cover and must NEVER be what the kid uncovers:
   *  every finish path reloads it pristine (BUG-FIX-LOG 2026-07-20). */
  private probeClicked = false;
  private settled = true; // no round active until start()
  private timer: unknown = null;

  constructor(deps: VerifyControllerDeps) {
    this.deps = deps;
    this.state = {
      phase: "done",
      currentHtml: "",
      round: 0,
      probesEnabled: false,
      checks: [],
      kidLine: null,
      question: null,
      outcome: null,
    };
  }

  getState(): VerifyControllerState {
    return this.state;
  }

  /** Begin verifying a fresh generation. §8.1/V.10: rAF doesn't tick in a
   *  hidden tab — verifying there would "repair" healthy games, so skip. */
  start(html: string, originalRequest: string, documentHidden: boolean): void {
    this.originalRequest = originalRequest;
    this.t0 = this.deps.now();
    this.attempt = 0;
    this.interrupted = false;
    this.versions = [];
    if (documentHidden) {
      this.emit({ ...this.state, phase: "done", currentHtml: html, probesEnabled: false, outcome: "skipped" });
      this.deps.track("preview_verify", { outcome: "skipped", attempts: 0, failure_code: null, ms: 0 });
      return;
    }
    this.beginRound(html);
  }

  /** Browser message events, forwarded verbatim by the adapter. */
  handleMessage(data: unknown): void {
    if (this.disposed || this.state.phase !== "testing" || this.settled) return;
    const d = data as
      | { source?: string; message?: GameConsoleMessage; event?: VerifyScriptEvent }
      | null;
    if (!d?.source) return;
    if (d.source === GAME_CONSOLE_SOURCE && d.message?.level === "error") {
      this.errors.push(d.message);
    } else if (d.source === PREVIEW_VERIFY_SOURCE && d.event) {
      const ev = d.event;
      if (ev.type === "clicked") {
        this.probeClicked = true;
      } else if (ev.type === "check") {
        this.emit({
          ...this.state,
          checks: [...this.state.checks.filter((c) => c.check !== ev.check), { check: ev.check, ok: ev.ok }],
        });
      } else if (ev.type === "result") {
        this.evidence = ev.evidence;
        void this.settle();
      }
    }
  }

  /** V.11 — tab hidden mid-window: rAF stops; no-loop reads are inconclusive. */
  markInterrupted(): void {
    this.interrupted = true;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) this.deps.clearTimeout(this.timer);
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private emit(next: VerifyControllerState): void {
    this.state = next;
    if (!this.disposed) this.deps.onChange(next);
  }

  private beginRound(html: string): void {
    this.errors = [];
    this.evidence = null;
    this.probeClicked = false;
    this.settled = false;
    if (this.timer !== null) this.deps.clearTimeout(this.timer);
    this.timer = this.deps.setTimeout(() => void this.settle(), ROUND_HARD_TIMEOUT_MS);
    this.emit({
      ...this.state,
      phase: "testing",
      currentHtml: html,
      round: this.state.round + 1,
      probesEnabled: true,
      checks: [],
      kidLine: null,
    });
  }

  private async settle(): Promise<void> {
    if (this.settled || this.disposed) return;
    this.settled = true;
    if (this.timer !== null) this.deps.clearTimeout(this.timer);
    const roundHtml = this.state.currentHtml;
    const errors = this.errors;
    const c = classifyVerify({ errors, evidence: this.evidence, interrupted: this.interrupted });
    const isClean = c.code === "clean" || c.code === "inconclusive";
    this.versions.push({ html: roundHtml, severity: isClean ? 0 : errors.length > 0 ? 2 : 1 });

    if (isClean) {
      this.finish(c.code, false);
      return;
    }

    const elapsedMs = this.deps.now() - this.t0;
    if (
      !shouldRepair({
        code: c.code,
        attempt: this.attempt,
        elapsedMs,
        enabled: this.deps.repairEnabled,
        demonstrablyRunning: demonstrablyRunning(this.evidence),
      })
    ) {
      this.finish(c.code, elapsedMs >= WALL_CLOCK_CAP_MS);
      return;
    }

    // §8.3 State 3 — say it plainly, truthfully, from the failure code.
    this.emit({
      ...this.state,
      phase: "repairing",
      kidLine: this.attempt === 0 ? `Oops — ${REPAIR_TAXONOMY[c.code].kidLine}` : SECOND_ATTEMPT_LINE,
    });
    this.attempt++;
    const tRepair = this.deps.now();
    let patchedHtml: string | null = null;
    try {
      const res = await this.deps.fetchRepair({
        html: roundHtml,
        failureCode: c.code,
        evidence: "evidence" in c ? c.evidence : null,
        errors: errors.slice(0, 20),
        originalRequest: this.originalRequest,
      });
      patchedHtml = res.patchedHtml?.trim() ? res.patchedHtml : null;
    } catch {
      patchedHtml = null;
    }
    this.deps.track("preview_repair", {
      failure_code: c.code,
      attempt: this.attempt,
      success: Boolean(patchedHtml),
      ms: Math.round(this.deps.now() - tRepair),
    });
    if (this.disposed) return; // adapter torn down (new html / unmount) — only NOW may we drop
    if (!patchedHtml) {
      this.finish(c.code, false);
      return;
    }
    this.beginRound(patchedHtml); // patched — a fresh round verifies it
  }

  private finish(finalCode: string, bailed: boolean): void {
    // The probe clicks whenever it found a start control (§6.2) — the game is
    // then running headless behind the cover. NOT a parameter: call-site
    // guesses left the pass-through / lost-result / failed-repair paths
    // uncovering a ghost-started document (the kid saw mid-game or game-over
    // with no start screen — "non-playable until reopened", 2026-07-20).
    // Evidence is the fallback for rounds probed before the clicked event
    // existed in the injected script (a cached document, in principle).
    const probeClicked = this.probeClicked || Boolean(this.evidence?.start?.found);
    const outcome = verifyOutcome({ finalCode, attempts: this.attempt, bailed });
    const clean = finalCode === "clean" || finalCode === "inconclusive";
    this.deps.track("preview_verify", {
      outcome,
      attempts: this.attempt,
      failure_code: clean ? null : finalCode,
      ms: Math.round(this.deps.now() - this.t0),
    });
    let html = this.state.currentHtml;
    let question: string | null = null;
    // §9.1's question appears only when we actually TRIED and lost (repair
    // attempted or the clock blew) — a telemetry-only pass-through code
    // (e.g. canvas_static) uncovers silently: the game most likely works.
    if ((outcome === "failed" || outcome === "bailed") && (this.attempt > 0 || bailed)) {
      // §8.4 — uncover the BEST version we have (least-broken; earliest wins
      // ties, which favors the original over a possibly-drifted patch).
      const best = [...this.versions].sort((a, b) => a.severity - b.severity)[0];
      if (best) html = best.html;
      question = exhaustedQuestion();
    }
    this.emit({
      ...this.state,
      phase: "done",
      currentHtml: html,
      // Reload the iframe when the probe started the game (probeClicked) or
      // when we swapped back to a different best version; probes stay OFF in
      // the reloaded document so nothing ghost-clicks the kid's Start button.
      round: probeClicked || html !== this.state.currentHtml ? this.state.round + 1 : this.state.round,
      probesEnabled: false,
      kidLine: null,
      question,
      outcome,
    });
  }
}
