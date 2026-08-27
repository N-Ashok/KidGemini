// Kid-facing Sparks numbers (docs/2026-08-27_PRD_SparksPage.md §4):
// whole Sparks (owner: "rounding yes"), compact past 10k, per-chat total.
import { describe, it, expect } from "vitest";
import { formatSparks, summarizeStatement, chatSparksTotal } from "./sparks-display";
import type { ChatMessage } from "@/types/chat.types";

const m = (role: "child" | "assistant", sparks?: number): ChatMessage =>
  ({ id: crypto.randomUUID(), role, text: "x", createdAt: 1, ...(sparks !== undefined ? { sparks } : {}) });

describe("chatSparksTotal", () => {
  it("D.7 sums receipts on assistant replies; child messages and un-receipted replies count 0", () => {
    expect(chatSparksTotal([m("child"), m("assistant", 12), m("child"), m("assistant"), m("assistant", 3.4)])).toBe(15.4);
    expect(chatSparksTotal([])).toBe(0);
  });
});

describe("formatSparks", () => {
  it("D.1 whole Sparks, rounded, with a thousands separator", () => {
    expect(formatSparks(12)).toBe("12");
    expect(formatSparks(11.6)).toBe("12");
    expect(formatSparks(1240)).toBe("1,240");
  });
  it("D.2 a tiny but non-zero charge shows as 1, never 0 (a paid ask is never 'free')", () => {
    expect(formatSparks(0.3)).toBe("1");
    expect(formatSparks(0)).toBe("0");
  });
  it("D.3 compact past 10k so the nav pill never grows", () => {
    expect(formatSparks(12_400)).toBe("12k");
    expect(formatSparks(125_000)).toBe("125k");
  });
  it("D.4 junk is '0' — never NaN on screen", () => {
    expect(formatSparks(Number.NaN)).toBe("0");
    expect(formatSparks(-5)).toBe("0");
  });
});

describe("summarizeStatement", () => {
  it("D.5 available = ledger balance; used = sum of debits; added = sum of credits", () => {
    expect(summarizeStatement({ balance: 954, transactions: [{ amount: 1000 }, { amount: -40 }, { amount: -6 }] }))
      .toEqual({ balance: 954, used: 46, added: 1000 });
  });
  it("D.6 a malformed statement yields nulls, never NaN", () => {
    expect(summarizeStatement({})).toEqual({ balance: null, used: null, added: null });
    expect(summarizeStatement({ balance: "x", transactions: "nope" })).toEqual({ balance: null, used: null, added: null });
  });
});
