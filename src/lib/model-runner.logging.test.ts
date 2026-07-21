// Operator-log legibility for the fallback chain (owner ask 2026-07-21):
// when the chain walks to the 2nd/3rd model it must be OBVIOUS from the log
//   (a) WHEN each model triggered — elapsed ms since the chain opened, and
//   (b) WHICH model finally produced the answer that was served.
// Before this, model-runner lines carried no elapsed marker and nothing named
// the winner, so on a fallback turn you had to infer the served model by eye
// from the WARN lines above `✓ shown`. These assertions pin the format so the
// timing + served-by lines can't silently regress. Format only — the walk
// semantics are covered by gemini.fallback.test.ts F.1–F.7 (kept untouched).
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { runStreamChain } from "./model-runner";
import type { ProviderChunk } from "./model-runner";
import type { ChainSummary } from "@/types/model-ledger.types";

/** An async stream that yields one answer chunk then ends cleanly. */
async function* answers(text: string): AsyncGenerator<ProviderChunk> {
  yield { text };
}

const overload = () => Object.assign(new Error("503 model overloaded"), { name: "OverloadError" });

/** Drain the runner to completion, discarding chunks (we assert on logs). */
async function drain(gen: AsyncGenerator<unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _ of gen) { /* consume */ }
}

const baseDeps = (openStream: (model: string, retries: number) => Promise<AsyncIterable<ProviderChunk>>) => ({
  openStream,
  shouldTryNextModel: () => true,
  isModelGone: () => false,
  stallMs: 10_000,
  wrapError: (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
});

let warn: ReturnType<typeof vi.spyOn>;
let log: ReturnType<typeof vi.spyOn>;
const warned = (): string[] => warn.mock.calls.map((c: unknown[]) => String(c[0]));
const logged = (): string[] => log.mock.calls.map((c: unknown[]) => String(c[0]));

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  log = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  log.mockRestore();
});

describe("fallback-chain log legibility", () => {
  it("L.1 stamps the chain position AND elapsed ms when the 2nd model triggers", async () => {
    // Primary refuses at open → chain walks to model #2, which answers.
    const openStream = vi.fn(async (model: string) => {
      if (model === "primary") throw overload();
      return answers("Here's your game!");
    });
    await drain(runStreamChain({ chain: ["primary", "backup"], ...baseDeps(openStream) }));

    const trigger = warned().find((l) => l.includes("backup"));
    expect(trigger, "a fallback trigger line for the 2nd model").toBeDefined();
    // "#2/2" makes the chain depth explicit; "@<n>ms" is the elapsed trigger time.
    expect(trigger).toMatch(/#2\/2/);
    expect(trigger).toMatch(/@\d+ms/);
  });

  it("L.2 names the model that actually served the answer, with elapsed ms", async () => {
    const openStream = vi.fn(async (model: string) => {
      if (model === "primary") throw overload();
      return answers("Made it!");
    });
    await drain(runStreamChain({ chain: ["primary", "backup"], ...baseDeps(openStream) }));

    const served = logged().find((l) => l.includes("served by"));
    expect(served, "a served-by line naming the winner").toBeDefined();
    expect(served).toContain("backup");
    expect(served).toMatch(/@\d+ms/);
  });

  it("L.3 a clean primary turn still names the served model (no fallback needed)", async () => {
    const openStream = vi.fn(async () => answers("First-try game"));
    await drain(runStreamChain({ chain: ["primary", "backup"], ...baseDeps(openStream) }));

    const served = logged().find((l) => l.includes("served by"));
    expect(served).toContain("primary");
    // No fallback trigger should have fired.
    expect(warned().some((l) => l.includes("falling back") || l.includes("#2/"))).toBe(false);
  });
});

describe("per-request decision ledger (onLedger)", () => {
  it("L.4 emits every call for one request — the loser AND the winner — with the winner named", async () => {
    // Primary refuses, backup answers: two calls, one request.
    const openStream = vi.fn(async (model: string) => {
      if (model === "primary") throw overload();
      return answers("Made it!");
    });
    let summary: ChainSummary | undefined;
    await drain(runStreamChain({
      chain: ["primary", "backup"],
      ...baseDeps(openStream),
      onLedger: (s: ChainSummary) => { summary = s; },
    }));

    expect(summary, "onLedger fires once the chain settles").toBeDefined();
    expect(summary!.winner).toBe("backup");
    // BOTH calls are on the record — the losing one is what usage_events drops.
    expect(summary!.attempts.map((a) => a.model)).toEqual(["primary", "backup"]);
    expect(summary!.attempts[0]!.role).toBe("primary");
    expect(summary!.attempts[0]!.outcome).not.toBe("won");
    const win = summary!.attempts.find((a) => a.outcome === "won")!;
    expect(win.model).toBe("backup");
    expect(win.role).toBe("fallback#2");
    expect(win.chars).toBeGreaterThan(0);
  });

  it("L.5 a clean primary turn records exactly ONE call, winner=primary", async () => {
    const openStream = vi.fn(async () => answers("First-try game"));
    let summary: ChainSummary | undefined;
    await drain(runStreamChain({
      chain: ["primary", "backup"],
      ...baseDeps(openStream),
      onLedger: (s: ChainSummary) => { summary = s; },
    }));
    expect(summary!.winner).toBe("primary");
    expect(summary!.attempts).toHaveLength(1);
    expect(summary!.attempts[0]!.outcome).toBe("won");
  });

  it("L.6 a total failure reports winner=null with every failed call recorded", async () => {
    const openStream = vi.fn(async () => { throw overload(); });
    let summary: ChainSummary | undefined;
    await expect(drain(runStreamChain({
      chain: ["primary", "backup"],
      ...baseDeps(openStream),
      onLedger: (s: ChainSummary) => { summary = s; },
    }))).rejects.toBeTruthy();
    expect(summary!.winner).toBeNull();
    expect(summary!.attempts).toHaveLength(2);
    expect(summary!.attempts.every((a) => a.outcome !== "won")).toBe(true);
  });
});
