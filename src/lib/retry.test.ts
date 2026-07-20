// BUG-FIX-LOG 2026-07-20 ("225 seconds, then nothing"). Retrying OUR OWN
// deadline is never useful: the same call with the same budget produces the
// same timeout, so each retry burns another full budget for free. Production
// spent 90s on the primary alone this way (3 × 30s) before the chain even
// started walking.
import { describe, expect, it, vi } from "vitest";
import { withRetry, withTimeout, TimeoutError } from "./retry";

const nextTick = () => new Promise((r) => setTimeout(r, 0));

describe("withTimeout", () => {
  it("T.1 rejects with a TimeoutError naming the label and budget", async () => {
    const slow = () => new Promise((r) => setTimeout(r, 50));
    await expect(withTimeout(slow, 5, "gemini.chat")).rejects.toBeInstanceOf(TimeoutError);
    await expect(withTimeout(slow, 5, "gemini.chat")).rejects.toThrow(/gemini\.chat timed out after 5ms/);
  });

  it("T.2 passes a fast result straight through", async () => {
    await expect(withTimeout(async () => "ok", 50)).resolves.toBe("ok");
  });
});

describe("withRetry", () => {
  it("T.3 retries genuine transient upstream failures", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('got status: UNAVAILABLE. {"code":503,"message":"high demand"}'))
      .mockResolvedValueOnce("recovered");
    await expect(withRetry(fn, { retries: 2, baseMs: 1 })).resolves.toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  // THE incident fix: one attempt, not three.
  it("T.4 does NOT retry our own timeout — the same budget would just expire again", async () => {
    const fn = vi.fn().mockRejectedValue(new TimeoutError("gemini.chat", 30_000));
    await expect(withRetry(fn, { retries: 2, baseMs: 1 })).rejects.toBeInstanceOf(TimeoutError);
    expect(fn).toHaveBeenCalledTimes(1); // was 3 → 60s of pure waiting saved per model
  });

  it("T.5 still retries an UPSTREAM deadline (DEADLINE_EXCEEDED) — that one can be transient", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("504 DEADLINE_EXCEEDED"))
      .mockResolvedValueOnce("recovered");
    await expect(withRetry(fn, { retries: 2, baseMs: 1 })).resolves.toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("T.6 never retries a caller defect", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("400 INVALID_ARGUMENT: bad request"));
    await expect(withRetry(fn, { retries: 3, baseMs: 1 })).rejects.toThrow(/INVALID_ARGUMENT/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("T.7 gives up after the configured attempts", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("503 UNAVAILABLE"));
    await expect(withRetry(fn, { retries: 2, baseMs: 1 })).rejects.toThrow(/UNAVAILABLE/);
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2
    await nextTick();
  });
});
