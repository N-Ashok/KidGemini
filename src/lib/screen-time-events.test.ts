// Feature 4 (2026-07-28) — tiny pub/sub bridging the globally-mounted
// ScreenTimeHeartbeat.tsx to the chat-page-scoped ScreenTimeNudgeBanner.tsx.
import { describe, it, expect, vi } from "vitest";
import { onNearingCap, emitNearingCap } from "./screen-time-events";

describe("screen-time-events", () => {
  it("a subscribed listener is called on emit", () => {
    const fn = vi.fn();
    const unsubscribe = onNearingCap(fn);
    emitNearingCap();
    expect(fn).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("unsubscribing stops further delivery", () => {
    const fn = vi.fn();
    const unsubscribe = onNearingCap(fn);
    unsubscribe();
    emitNearingCap();
    expect(fn).not.toHaveBeenCalled();
  });

  it("multiple listeners all receive the same emit", () => {
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = onNearingCap(a);
    const unsubB = onNearingCap(b);
    emitNearingCap();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    unsubA();
    unsubB();
  });

  it("emitting with no listeners is a no-op, not a throw", () => {
    expect(() => emitNearingCap()).not.toThrow();
  });
});
