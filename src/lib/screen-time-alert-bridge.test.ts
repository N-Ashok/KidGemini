/** Screen-time cap-exceeded alert bridge — contract + fail-safety.
 *  Feature 4 (2026-07-28). Mirrors parent-pin-otp-bridge.test.ts. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendScreenTimeAlertEmail } from "./screen-time-alert-bridge";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.AUTH_JWT_SECRET = "test-secret";
  fetchMock = vi.fn(() => Promise.resolve({ ok: true, status: 200 } as unknown as Response));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendScreenTimeAlertEmail", () => {
  it("POSTs the alert details with the secret header and returns true on 200", async () => {
    const ok = await sendScreenTimeAlertEmail("parent@example.com", "Kid", 40, 30);
    expect(ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/api/studio/partner/screen-time-alert");
    expect((init.headers as Record<string, string>)["x-admin-secret"]).toBe("test-secret");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ parentEmail: "parent@example.com", childLabel: "Kid", activeMinutes: 40, capMinutes: 30 });
  });

  it("returns false (never throws) on a non-2xx response", async () => {
    fetchMock.mockImplementation(() => Promise.resolve({ ok: false, status: 502 } as unknown as Response));
    expect(await sendScreenTimeAlertEmail("parent@example.com", "Kid", 40, 30)).toBe(false);
  });

  it("returns false (never throws) when the network is down", async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error("ECONNREFUSED")));
    await expect(sendScreenTimeAlertEmail("parent@example.com", "Kid", 40, 30)).resolves.toBe(false);
  });
});
