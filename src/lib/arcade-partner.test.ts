import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { partner } from "./arcade-partner";

const OLD_SECRET = process.env.AUTH_JWT_SECRET;
process.env.AUTH_JWT_SECRET = "test-secret";
afterAll(() => {
  process.env.AUTH_JWT_SECRET = OLD_SECRET;
});

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("arcade-partner — shared bridge to the platform (2026-07-17)", () => {
  it("forwards a successful response through unchanged", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 200, json: async () => ({ url: "https://x.ariantra.com/" }) })));
    const res = await partner({ hello: "world" });
    expect(res).toEqual({ status: 200, data: { url: "https://x.ariantra.com/" } });
  });

  it("remaps a 403 (secret mismatch) to a distinct 502 instead of forwarding it verbatim (BUG-FIX-LOG 2026-07-11)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 403, json: async () => { throw new Error("not json"); } })));
    const res = await partner({});
    expect(res.status).toBe(502);
    expect(res.data.error).toMatch(/same secret/);
  });

  it("never throws on a network failure — returns a clean 502 instead of an uncaught rejection", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("fetch failed: ECONNREFUSED");
    }));
    const res = await partner({});
    expect(res.status).toBe(502);
    expect(typeof res.data.error).toBe("string");
  });

  it("passes an AbortSignal so a hung request can't block the caller forever", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return { status: 200, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);
    await partner({});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
