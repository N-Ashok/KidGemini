// Sparks receipt (docs/2026-08-27_PRD_SparksPage.md §3): after a turn's
// debit(s) are sent, the chat route waits a BOUNDED moment for the platform's
// { charged, balance } answers and emits one `sparks` frame. A slow or dead
// platform never delays the kid — the wait caps and the frame is skipped.
import { describe, it, expect } from "vitest";
import { settleSparksReceipt } from "./sparks-receipt";

const never = () => new Promise<null>(() => {});

describe("settleSparksReceipt", () => {
  it("SR.1 sums charged across every debit of the turn and takes the LAST balance", async () => {
    const r = await settleSparksReceipt([
      Promise.resolve({ charged: 8, balance: 292 }),
      Promise.resolve({ charged: 4, balance: 288 }),
    ], 200);
    expect(r).toEqual({ charged: 12, balance: 288 });
  });
  it("SR.2 no debits (guest / safety-only turn) → null, and returns immediately", async () => {
    expect(await settleSparksReceipt([], 200)).toBeNull();
  });
  it("SR.3 a rejected or null debit answer is skipped, the others still count", async () => {
    const r = await settleSparksReceipt([Promise.resolve(null), Promise.resolve({ charged: 5, balance: 100 })], 200);
    expect(r).toEqual({ charged: 5, balance: 100 });
  });
  it("SR.4 caps the wait — a platform that never answers yields null within the budget", async () => {
    const t0 = Date.now();
    expect(await settleSparksReceipt([never()], 40)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(400);
  });
  it("SR.5 partial answers inside the budget are reported (never wait on the slow one)", async () => {
    const r = await settleSparksReceipt([Promise.resolve({ charged: 3, balance: 50 }), never()], 40);
    expect(r).toEqual({ charged: 3, balance: 50 });
  });
});
