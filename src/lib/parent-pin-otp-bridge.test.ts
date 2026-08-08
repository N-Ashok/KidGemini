/** Parent-PIN OTP bridge — contract + fail-safety. BUG-FIX-LOG 2026-07-27,
 *  redesigned 2026-08-08 (docs/BUG-FIX-LOG.md "parent-PIN OTP false
 *  no-email"): sends a `playerId`, not a plaintext email — Ari cannot
 *  reliably know one itself (a username/password login's SSO session
 *  carries no email claim); the platform resolves the real contact email
 *  server-side and returns only a masked version. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendParentPinOtpEmail } from "./parent-pin-otp-bridge";

let fetchMock: ReturnType<typeof vi.fn>;

const okJson = (data: unknown) =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) } as unknown as Response);

beforeEach(() => {
  process.env.AUTH_JWT_SECRET = "test-secret";
  fetchMock = vi.fn(() => okJson({ ok: true, maskedEmail: "p****@example.com" }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendParentPinOtpEmail", () => {
  it("POSTs the playerId (not an email) with the secret header, and returns the masked email the platform resolved", async () => {
    const result = await sendParentPinOtpEmail("player-42", "482913");
    expect(result).toEqual({ ok: true, maskedEmail: "p****@example.com" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/api/studio/partner/parent-pin-otp");
    expect((init.headers as Record<string, string>)["x-admin-secret"]).toBe("test-secret");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ playerId: "player-42", code: "482913" });
    expect(body).not.toHaveProperty("email"); // never guesses/forwards a plaintext address
  });

  it("returns {ok:false, error:'no_email'} when the platform has no contact email on file — never throws", async () => {
    fetchMock.mockImplementation(() => okJson({ ok: false, error: "no_email" }));
    expect(await sendParentPinOtpEmail("player-42", "482913")).toEqual({ ok: false, error: "no_email" });
  });

  it("returns {ok:false, error:'send_failed'} on a non-2xx response", async () => {
    fetchMock.mockImplementation(() => Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({}) } as unknown as Response));
    expect(await sendParentPinOtpEmail("player-42", "482913")).toEqual({ ok: false, error: "send_failed" });
  });

  it("returns {ok:false, error:'send_failed'} (never throws) when the network is down", async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error("ECONNREFUSED")));
    await expect(sendParentPinOtpEmail("player-42", "482913")).resolves.toEqual({ ok: false, error: "send_failed" });
  });
});
