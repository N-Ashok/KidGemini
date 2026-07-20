// Pins the one-shot chain's "never discard an attempt" behaviour
// (owner decision 2026-07-20, PRD-RESILIENT-GENERATION option 3).
//
// The old chain was serial-abandon-degrade: cut the primary at its deadline,
// throw the in-flight work away, start a WEAKER model from zero, and serve
// whatever that produced. In production the primary's (better) answer had
// almost always already arrived unheard — the deadline was 30s and the same
// work streamed successfully at 31.2s and 46.4s.
//
// Now the deadline only ADVANCES the chain; it never discards. When the slot
// deadline passes we start the next model as a backup and keep the earlier
// attempt running — and because that attempt is already N seconds into its
// work while the backup starts from zero, the better model usually still wins.
import { describe, expect, it, vi } from "vitest";
import { runOneShotChain } from "./model-runner";

const CHAIN = ["best-model", "ok-model", "weak-model"];

/** Resolves with `value` after `ms`. */
const after = <T>(ms: number, value: T) => new Promise<T>((r) => setTimeout(() => r(value), ms));
/** Rejects after `ms`. */
const failsAfter = (ms: number, err: Error) =>
  new Promise<never>((_, rej) => setTimeout(() => rej(err), ms));

const walkAll = () => true;
const noneGone = () => false;

const run = (call: (model: string) => Promise<string>, opts: Partial<Parameters<typeof runOneShotChain>[0]> = {}) =>
  runOneShotChain({
    chain: CHAIN,
    label: "test",
    primaryRetries: 0,
    slotDeadlineMs: 20,
    call,
    shouldTryNextModel: walkAll,
    isModelGone: noneGone,
    ...opts,
  } as Parameters<typeof runOneShotChain>[0]);

describe("keeping the first call's result", () => {
  it("B.1 a slow PRIMARY that lands after its deadline still wins over a freshly started fallback", async () => {
    // The exact production shape: primary needs 35ms against a 20ms slot
    // deadline; the fallback starts at 20ms and would need until 60ms.
    const call = vi.fn((model: string) =>
      model === "best-model" ? after(35, "GOOD game from the best model") : after(40, "worse game"),
    );

    const out = await run(call);

    const tried = call.mock.calls.map((c) => c[0]);
    expect(out).toBe("GOOD game from the best model");
    expect(tried).toContain("best-model");
    expect(tried).toContain("ok-model"); // backup WAS started…
    expect(tried).not.toContain("weak-model"); // …but we never degraded that far
  });

  it("B.2 the deadline ADVANCES the chain without discarding — earlier attempts stay alive", async () => {
    // Only the primary ever succeeds, and only well after two slot deadlines.
    const call = vi.fn((model: string) =>
      model === "best-model" ? after(50, "late but best") : new Promise<string>(() => {}),
    );

    await expect(run(call)).resolves.toBe("late but best");
  });

  it("B.3 returns the moment ANY attempt succeeds — no waiting for the rest", async () => {
    const started = Date.now();
    const call = (model: string) => (model === "ok-model" ? after(5, "fast backup") : new Promise<string>(() => {}));

    await expect(run(call)).resolves.toBe("fast backup");
    expect(Date.now() - started).toBeLessThan(200); // did not sit out the whole chain
  });
});

describe("failures still behave", () => {
  it("B.4 an attempt that REJECTS is dropped and the chain moves on", async () => {
    const call = vi.fn((model: string) =>
      model === "best-model" ? failsAfter(2, new Error("503 UNAVAILABLE")) : after(5, "rescued"),
    );

    await expect(run(call)).resolves.toBe("rescued");
    expect(call.mock.calls.map((c) => c[0])).toContain("ok-model");
  });

  it("B.5 a real defect throws immediately — no backup started, nothing masked", async () => {
    const call = vi.fn(() => failsAfter(2, new Error("400 INVALID_ARGUMENT")));

    await expect(run(call, { shouldTryNextModel: () => false })).rejects.toThrow(/INVALID_ARGUMENT/);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("B.6 when every attempt fails, the last error surfaces", async () => {
    const call = () => failsAfter(2, new Error("503 UNAVAILABLE"));
    await expect(run(call)).rejects.toThrow(/UNAVAILABLE/);
  });

  it("B.7 a total budget bounds the wait even if every attempt hangs forever", async () => {
    const call = () => new Promise<string>(() => {}); // never settles
    await expect(run(call, { totalBudgetMs: 60 })).rejects.toThrow(/gave up|timed out|budget/i);
  });
});
