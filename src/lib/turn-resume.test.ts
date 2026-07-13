import { describe, it, expect } from "vitest";
import { pollTurnResult } from "./turn-resume";

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
});
