import { describe, it, expect } from "vitest";
import { shouldAutoRetry, STREAM_RETRY_LIMIT } from "./stream-recovery";

/** Regression (BUG-FIX-LOG 2026-07-09): mid-stream socket drops (screen lock /
 *  app switch) told the kid "Ask me again and I'll redo it!" — often. The
 *  client must retry by itself; the kid only sees a message when retries are
 *  exhausted. */
describe("shouldAutoRetry", () => {
  it("retries a dropped stream up to the limit", () => {
    expect(shouldAutoRetry({ manualStop: false, finalized: false, attempt: 0 })).toBe(true);
    expect(shouldAutoRetry({ manualStop: false, finalized: false, attempt: STREAM_RETRY_LIMIT - 1 })).toBe(true);
  });
  it("gives up once the limit is reached", () => {
    expect(shouldAutoRetry({ manualStop: false, finalized: false, attempt: STREAM_RETRY_LIMIT })).toBe(false);
  });
  it("never retries after the kid pressed Stop", () => {
    expect(shouldAutoRetry({ manualStop: true, finalized: false, attempt: 0 })).toBe(false);
  });
  it("never retries a reply that already finalized (done/blocked/gated)", () => {
    expect(shouldAutoRetry({ manualStop: false, finalized: true, attempt: 0 })).toBe(false);
  });
  it("the limit is small — every retry is a fresh paid generation", () => {
    expect(STREAM_RETRY_LIMIT).toBeLessThanOrEqual(2);
  });
});
