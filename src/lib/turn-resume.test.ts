import { describe, it, expect } from "vitest";
import { pollTurnResult, pollTurnOutcome, RESUME_MAX_MS } from "./turn-resume";

const noSleep = () => Promise.resolve();
const json = (body: unknown, status = 200) =>
  ({ ok: status === 200, status, json: async () => body }) as Response;

describe("pollTurnResult — resume instead of re-generate", () => {
  it("returns the finished reply when the server has it", async () => {
    const fetchFn = (async () => json({ status: "done", text: "Here!", artifactHtml: "<html>g</html>" })) as typeof fetch;
    expect(await pollTurnResult("r1", { fetchFn, sleep: noSleep })).toEqual({
      text: "Here!",
      artifactHtml: "<html>g</html>",
    });
  });

  it("keeps waiting while `running`, then collects — heavy-load patience", async () => {
    let calls = 0;
    const fetchFn = (async () =>
      ++calls < 4 ? json({ status: "running" }) : json({ status: "done", text: "slow but done", artifactHtml: null })) as typeof fetch;
    const out = await pollTurnResult("r1", { fetchFn, sleep: noSleep, maxMs: 100_000, intervalMs: 4_000 });
    expect(out?.text).toBe("slow but done");
    expect(calls).toBe(4);
  });

  it("gives up (→ re-generate) on 404, server error status, or budget exhaustion", async () => {
    expect(await pollTurnResult("r1", { fetchFn: (async () => json({}, 404)) as typeof fetch, sleep: noSleep })).toBeNull();
    expect(
      await pollTurnResult("r1", { fetchFn: (async () => json({ status: "error" })) as typeof fetch, sleep: noSleep }),
    ).toBeNull();
    const alwaysRunning = (async () => json({ status: "running" })) as typeof fetch;
    expect(await pollTurnResult("r1", { fetchFn: alwaysRunning, sleep: noSleep, maxMs: 12_000, intervalMs: 4_000 })).toBeNull();
  });

  it("network hiccups while polling are ticks, not verdicts", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      if (calls === 1) throw new Error("offline");
      return json({ status: "done", text: "back online", artifactHtml: null });
    }) as typeof fetch;
    const out = await pollTurnResult("r1", { fetchFn, sleep: noSleep, maxMs: 20_000 });
    expect(out?.text).toBe("back online");
  });

  // Dead-server fail-fast (BUG-FIX-LOG 2026-07-18): a stopped dev server /
  // dead network meant EVERY poll threw — but each throw counted as a patient
  // "offline tick", so the kid stared at "Reconnecting… hang tight!" for the
  // full 4-minute budget (×3 attempts ≈ 12 minutes, composer locked).
  it("fails fast when the server was NEVER reachable — no 4-minute stare", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      throw new Error("connection refused");
    }) as typeof fetch;
    const out = await pollTurnResult("r1", {
      fetchFn,
      sleep: noSleep,
      maxMs: 240_000,
      intervalMs: 4_000,
      unreachableMaxMs: 20_000,
    });
    expect(out).toBeNull();
    expect(calls).toBeLessThanOrEqual(6); // ~20s of ticks, not 60 ticks (4 min)
  });

  it("keeps full heavy-load patience once the server HAS answered", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      if (calls === 1) return json({ status: "running" }); // server is alive, just slow
      throw new Error("blip"); // later hiccups must NOT trip the fail-fast
    }) as typeof fetch;
    const out = await pollTurnResult("r1", {
      fetchFn,
      sleep: noSleep,
      maxMs: 40_000,
      intervalMs: 4_000,
      unreachableMaxMs: 8_000,
    });
    expect(out).toBeNull(); // budget exhaustion, not early bail…
    expect(calls).toBe(11); // …proven by using ALL ticks of the 40s budget (0..40s every 4s)
  });

  // Tab-close recovery needs the REASON, not just reply-or-null: "still
  // generating" must keep the device's bookmark for the next load, while
  // "gone" must drop it (BUG-FIX-LOG 2026-07-28).
  describe("pollTurnOutcome — distinguishes still-cooking from gone", () => {
    it("reports `running` when the budget runs out on a live, still-generating server", async () => {
      const alwaysRunning = (async () => json({ status: "running" })) as typeof fetch;
      expect(await pollTurnOutcome("r1", { fetchFn: alwaysRunning, sleep: noSleep, maxMs: 12_000, intervalMs: 4_000 })).toEqual({
        status: "running",
      });
    });

    it("reports `unknown` on 404 and on a server that never answered", async () => {
      expect(await pollTurnOutcome("r1", { fetchFn: (async () => json({}, 404)) as typeof fetch, sleep: noSleep })).toEqual({
        status: "unknown",
      });
      const dead = (async () => { throw new Error("connection refused"); }) as typeof fetch;
      expect(await pollTurnOutcome("r1", { fetchFn: dead, sleep: noSleep, unreachableMaxMs: 8_000, intervalMs: 4_000 })).toEqual({
        status: "unknown",
      });
    });

    it("reports `error` on a server-side failure, and `done` with the reply", async () => {
      expect(await pollTurnOutcome("r1", { fetchFn: (async () => json({ status: "error" })) as typeof fetch, sleep: noSleep })).toEqual({
        status: "error",
      });
      expect(
        await pollTurnOutcome("r1", {
          fetchFn: (async () => json({ status: "done", text: "hi", artifactHtml: null })) as typeof fetch,
          sleep: noSleep,
        }),
      ).toEqual({ status: "done", text: "hi", artifactHtml: null });
    });

    it("onRunning fires per waiting tick, so the UI can say it's still working", async () => {
      let calls = 0;
      const fetchFn = (async () =>
        ++calls < 3 ? json({ status: "running" }) : json({ status: "done", text: "ok", artifactHtml: null })) as typeof fetch;
      const seen: number[] = [];
      await pollTurnOutcome("r1", { fetchFn, sleep: noSleep, intervalMs: 4_000, onRunning: (ms) => seen.push(ms) });
      expect(seen).toEqual([0, 4_000]);
    });

    // The regression itself: recovery used to hand this poll a 6s budget, so a
    // build that takes minutes was declared dead the moment the kid came back.
    it("defaults to minutes of patience, not seconds", () => {
      expect(RESUME_MAX_MS).toBeGreaterThanOrEqual(120_000);
    });
  });

  // Stop button during "Reconnecting…" (same bug report): the poll loop was
  // not stop-aware, so pressing ⏹ did nothing until the budget ran out.
  it("shouldStop breaks the poll immediately", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return json({ status: "running" });
    }) as typeof fetch;
    const out = await pollTurnResult("r1", {
      fetchFn,
      sleep: noSleep,
      maxMs: 240_000,
      intervalMs: 4_000,
      shouldStop: () => calls >= 2, // kid presses Stop after the 2nd tick
    });
    expect(out).toBeNull();
    expect(calls).toBe(2);
  });
});
