// Save & continue building — the parent-side request/response wrapper around
// the save-state postMessage protocol (docs/2026-08-01_PRD_SaveContinueBuilding.md
// §3b). Modeled on preview-verify-controller.ts: framework-free, deps
// injected, unit-testable with fake timers — no real DOM/window needed. React
// wiring (a useGameSaveChannel hook, mirroring usePreviewVerify.ts) owns the
// actual iframeRef/window listeners and is a thin adapter over this class,
// same division of responsibility as the verify flow (SRP: this class only
// correlates one request with its one reply).

import { sanitizeGameSaveState } from "./game-save";
import type { GameSaveState } from "@/types/game-save.types";

/** If the game never replies (a stuck tab, a game that doesn't implement the
 *  contract despite the marker, a crashed document), stop waiting rather than
 *  stall the autosave loop forever. */
export const REQUEST_SAVE_TIMEOUT_MS = 2_000;

export type SaveRequestResult =
  | { ok: true; state: GameSaveState }
  | { ok: false; reason: "timeout" | "invalid" };

export interface GameSaveChannelDeps {
  /** Posts a message into the game's iframe (contentWindow.postMessage). */
  postMessage: (msg: unknown) => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (t: unknown) => void;
}

interface PendingRequest {
  resolve: (result: SaveRequestResult) => void;
  timer: unknown;
}

export class GameSaveChannel {
  private pending: PendingRequest | null = null;
  private disposed = false;

  constructor(private readonly deps: GameSaveChannelDeps) {}

  /** Ask the game for its current state. Any request already in flight is
   *  cancelled (resolved as a timeout) — only the newest reply can settle. */
  requestSave(): Promise<SaveRequestResult> {
    this.settlePending({ ok: false, reason: "timeout" });
    if (this.disposed) return Promise.resolve({ ok: false, reason: "timeout" });

    return new Promise((resolve) => {
      const timer = this.deps.setTimeout(() => this.settlePending({ ok: false, reason: "timeout" }), REQUEST_SAVE_TIMEOUT_MS);
      this.pending = { resolve, timer };
      this.deps.postMessage({ type: "ariantra:request-save" });
    });
  }

  /** Browser message events, forwarded verbatim by the adapter — same
   *  calling convention as PreviewVerifyController.handleMessage. */
  handleMessage(data: unknown): void {
    if (this.disposed || !this.pending) return;
    const d = data as { type?: string; payload?: unknown } | null;
    if (!d || typeof d !== "object" || d.type !== "ariantra:save-state") return;
    const state = sanitizeGameSaveState(d.payload);
    this.settlePending(state ? { ok: true, state } : { ok: false, reason: "invalid" });
  }

  dispose(): void {
    this.disposed = true;
    this.settlePending({ ok: false, reason: "timeout" });
  }

  private settlePending(result: SaveRequestResult): void {
    if (!this.pending) return;
    const { resolve, timer } = this.pending;
    this.pending = null;
    this.deps.clearTimeout(timer);
    resolve(result);
  }
}
