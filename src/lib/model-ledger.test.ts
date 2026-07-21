// Pins the decision-ledger file writer (owner ask 2026-07-21): one JSON line
// per request, appended, fail-safe. The line must be enough to reconstruct
// "how many calls this request made and which won" without any other source.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeDecision, ledgerPath } from "./model-ledger";
import type { DecisionLedger } from "@/types/model-ledger.types";

let file: string;

beforeEach(() => {
  file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ledger-")), "model-decisions.jsonl");
  process.env.MODEL_LEDGER_FILE = file;
});
afterEach(() => {
  delete process.env.MODEL_LEDGER_FILE;
});

const entry = (over: Partial<DecisionLedger> = {}): DecisionLedger => ({
  ts: "2026-07-21T00:00:00.000Z",
  reqId: "req-1",
  userId: "user:kohsa07@gmail.com",
  kind: "build",
  chain: ["g3-flash", "g2.5-flash"],
  attempts: [
    { model: "g3-flash", role: "primary", outcome: "overloaded", atMs: 21403 },
    { model: "g2.5-flash", role: "fallback#2", outcome: "won", atMs: 24560, chars: 8613 },
  ],
  winner: "g2.5-flash",
  calls: 2,
  ...over,
});

describe("model-decision ledger", () => {
  it("M.1 writes one JSONL line that round-trips with the winner and call count", () => {
    writeDecision(entry());
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as DecisionLedger;
    expect(parsed.winner).toBe("g2.5-flash");
    expect(parsed.calls).toBe(2);
    expect(parsed.attempts.map((a) => a.model)).toEqual(["g3-flash", "g2.5-flash"]);
    // The losing call is on the record even though only the winner was billed.
    expect(parsed.attempts[0]!.outcome).toBe("overloaded");
  });

  it("M.2 APPENDS across requests (never overwrites) so history accumulates", () => {
    writeDecision(entry({ reqId: "req-1" }));
    writeDecision(entry({ reqId: "req-2", winner: "g3-flash" }));
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[1]!) as DecisionLedger).reqId).toBe("req-2");
  });

  it("M.3 never throws when the path is unwritable (bookkeeping must not break a turn)", () => {
    process.env.MODEL_LEDGER_FILE = "/this/path/does/not/exist/and/cannot/be/made\0/x";
    expect(() => writeDecision(entry())).not.toThrow();
  });

  it("M.4 ledgerPath honours the env override", () => {
    expect(ledgerPath()).toBe(file);
  });
});
