/** Screen-time cap-exceeded alert bridge — contract + fail-safety.
 *  Feature 4 (2026-07-28). Redesigned 2026-08-08 (docs/BUG-FIX-LOG.md
 *  "parent-PIN OTP false no-email", same fix class): sends a `playerId`, not
 *  a plaintext parentEmail — the platform resolves the real contact email
 *  server-side, so a family signed in via username/password (whose SSO
 *  session never carries an email claim) still gets alerted. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendScreenTimeAlertEmail } from "./screen-time-alert-bridge";

let fetchMock: ReturnType<typeof vi.fn>;

const okJson = (data: unknown) =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) } as unknown as Response);

beforeEach(() => {
  process.env.AUTH_JWT_SECRET = "test-secret";
  fetchMock = vi.fn(() => okJson({ ok: true }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendScreenTimeAlertEmail", () => {
  it("POSTs the playerId (not an email) with the secret header and returns ok:true on success", async () => {
    const result = await sendScreenTimeAlertEmail("player-42", "Kid", 40, 30);
    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/api/studio/partner/screen-time-alert");
    expect((init.headers as Record<string, string>)["x-admin-secret"]).toBe("test-secret");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ playerId: "player-42", childLabel: "Kid", activeMinutes: 40, capMinutes: 30 });
    expect(body).not.toHaveProperty("parentEmail");
  });

  it("returns {ok:false, error:'no_email'} when the platform has no contact email on file — never throws", async () => {
    fetchMock.mockImplementation(() => okJson({ ok: false, error: "no_email" }));
    expect(await sendScreenTimeAlertEmail("player-42", "Kid", 40, 30)).toEqual({ ok: false, error: "no_email" });
  });

  it("returns {ok:false, error:'send_failed'} on a non-2xx response", async () => {
    fetchMock.mockImplementation(() => Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({}) } as unknown as Response));
    expect(await sendScreenTimeAlertEmail("player-42", "Kid", 40, 30)).toEqual({ ok: false, error: "send_failed" });
  });

  it("returns {ok:false, error:'send_failed'} (never throws) when the network is down", async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error("ECONNREFUSED")));
    await expect(sendScreenTimeAlertEmail("player-42", "Kid", 40, 30)).resolves.toEqual({ ok: false, error: "send_failed" });
  });
});
