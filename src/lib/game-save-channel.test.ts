// GameSaveChannel — request/response wrapper around the save-state postMessage
// protocol (docs/2026-08-01_PRD_SaveContinueBuilding.md §3b), modeled on
// PreviewVerifyController: framework-free, deps injected, fully unit-testable
// with fake timers — no real DOM/window needed.

import { describe, it, expect, vi } from "vitest";
import { GameSaveChannel, REQUEST_SAVE_TIMEOUT_MS } from "./game-save-channel";

function makeDeps() {
  const posted: unknown[] = [];
  const timers = new Map<number, () => void>();
  let nextTimerId = 1;
  return {
    posted,
    deps: {
      postMessage: (msg: unknown) => posted.push(msg),
      setTimeout: (fn: () => void, _ms: number) => {
        const id = nextTimerId++;
        timers.set(id, fn);
        return id;
      },
      clearTimeout: (t: unknown) => timers.delete(t as number),
      now: () => 0,
    },
    fireTimer: (id: number) => {
      const fn = timers.get(id);
      timers.delete(id);
      fn?.();
    },
    hasTimer: (id: number) => timers.has(id),
  };
}

const validPayload = {
  areas: [{ id: "a1", originX: 0, originZ: 0, objects: [{ type: "block", x: 1, y: 0, z: 1 }] }],
};

describe("GameSaveChannel — request/response", () => {
  it("posts exactly one ariantra:request-save message per requestSave() call", () => {
    const { deps, posted } = makeDeps();
    const channel = new GameSaveChannel(deps);
    void channel.requestSave();
    expect(posted).toEqual([{ type: "ariantra:request-save" }]);
  });

  it("resolves ok:true with the sanitized state when a matching valid reply arrives", async () => {
    const { deps } = makeDeps();
    const channel = new GameSaveChannel(deps);
    const promise = channel.requestSave();
    channel.handleMessage({ type: "ariantra:save-state", payload: validPayload });
    expect(await promise).toEqual({ ok: true, state: validPayload });
  });

  it("ignores messages of an unrelated type — never settles on noise", async () => {
    const { deps, fireTimer } = makeDeps();
    const channel = new GameSaveChannel(deps);
    const promise = channel.requestSave();
    channel.handleMessage({ type: "some-other-message" });
    channel.handleMessage({ source: "ari-game-console", message: { level: "log" } });
    channel.handleMessage(null);
    channel.handleMessage("not an object");
    fireTimer(1); // only the timeout should settle it
    expect(await promise).toEqual({ ok: false, reason: "timeout" });
  });

  it("resolves ok:false reason:invalid when the reply's payload fails validation", async () => {
    const { deps } = makeDeps();
    const channel = new GameSaveChannel(deps);
    const promise = channel.requestSave();
    channel.handleMessage({ type: "ariantra:save-state", payload: { areas: "not an array" } });
    expect(await promise).toEqual({ ok: false, reason: "invalid" });
  });

  it("resolves ok:false reason:timeout when the timer fires with no reply", async () => {
    const { deps, fireTimer } = makeDeps();
    const channel = new GameSaveChannel(deps);
    const promise = channel.requestSave();
    fireTimer(1);
    expect(await promise).toEqual({ ok: false, reason: "timeout" });
  });

  it("clears the timer once a valid reply settles the request (no stray timeout later)", async () => {
    const { deps, hasTimer } = makeDeps();
    const channel = new GameSaveChannel(deps);
    const promise = channel.requestSave();
    expect(hasTimer(1)).toBe(true);
    channel.handleMessage({ type: "ariantra:save-state", payload: validPayload });
    await promise;
    expect(hasTimer(1)).toBe(false);
  });

  it("a late duplicate reply after settling is a no-op (never rejects, never double-resolves)", async () => {
    const { deps } = makeDeps();
    const channel = new GameSaveChannel(deps);
    const promise = channel.requestSave();
    channel.handleMessage({ type: "ariantra:save-state", payload: validPayload });
    const result = await promise;
    expect(() => channel.handleMessage({ type: "ariantra:save-state", payload: validPayload })).not.toThrow();
    expect(result).toEqual({ ok: true, state: validPayload });
  });

  it("a second requestSave() before the first settles cancels the first as a timeout", async () => {
    const { deps } = makeDeps();
    const channel = new GameSaveChannel(deps);
    const first = channel.requestSave();
    const second = channel.requestSave();
    channel.handleMessage({ type: "ariantra:save-state", payload: validPayload });
    expect(await first).toEqual({ ok: false, reason: "timeout" });
    expect(await second).toEqual({ ok: true, state: validPayload });
  });

  it("dispose() settles any in-flight request and further requests are inert", async () => {
    const { deps, posted } = makeDeps();
    const channel = new GameSaveChannel(deps);
    const pending = channel.requestSave();
    channel.dispose();
    expect(await pending).toEqual({ ok: false, reason: "timeout" });

    posted.length = 0;
    const afterDispose = await channel.requestSave();
    expect(posted).toEqual([]); // never posts after dispose
    expect(afterDispose).toEqual({ ok: false, reason: "timeout" });
  });

  it("dispose() is safe to call twice and safe with no request in flight", () => {
    const { deps } = makeDeps();
    const channel = new GameSaveChannel(deps);
    expect(() => {
      channel.dispose();
      channel.dispose();
    }).not.toThrow();
  });
});

describe("GameSaveChannel — timeout budget", () => {
  it("REQUEST_SAVE_TIMEOUT_MS is short enough that a stuck game doesn't stall autosave for long", () => {
    expect(REQUEST_SAVE_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
    expect(REQUEST_SAVE_TIMEOUT_MS).toBeGreaterThanOrEqual(500);
  });
});
