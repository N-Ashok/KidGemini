/** Gate tests for the arcade publish bridge: PIN + session, fail-closed. */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { SignJWT } from "jose";

const cookieJar: { token: string } = { token: "" };
vi.mock("next/headers", () => ({
  cookies: () => ({ get: (name: string) => (name === "ariantra_session" && cookieJar.token ? { value: cookieJar.token } : undefined) }),
}));
vi.mock("server-only", () => ({}));

import { POST } from "./route";

const SECRET = "test-secret-long-enough-0123456789";
const OLD = { pin: process.env.PARENT_PIN, secret: process.env.AUTH_JWT_SECRET };
process.env.PARENT_PIN = "4321";
process.env.AUTH_JWT_SECRET = SECRET;

afterAll(() => {
  process.env.PARENT_PIN = OLD.pin;
  process.env.AUTH_JWT_SECRET = OLD.secret;
});

async function sessionToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ typ: "session", name: "Agilan" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("player-1")
    .setIssuer("ariantra")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(new TextEncoder().encode(SECRET));
}

const req = (body: unknown) => ({ json: async () => body }) as never;
const HTML = "<html><body>Score: 1</body></html>";

let platformCalls: unknown[];
beforeEach(() => {
  platformCalls = [];
  cookieJar.token = "";
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    platformCalls.push(JSON.parse(init.body));
    return { status: 200, json: async () => ({ url: "https://dragon-flyer.ariantra.com/", version: "v1" }) };
  }));
});

describe("arcade publish gates", () => {
  it("G.1 wrong PIN → 403 and the platform is never called", async () => {
    cookieJar.token = await sessionToken();
    const res = await POST(req({ name: "Dragon Flyer", html: HTML, pin: "0000" }));
    expect(res.status).toBe(403);
    expect(platformCalls).toHaveLength(0);
  });

  it("G.2 signed out (no session cookie) → 401, platform never called", async () => {
    const res = await POST(req({ name: "Dragon Flyer", html: HTML, pin: "4321" }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("signed_out");
    expect(platformCalls).toHaveLength(0);
  });

  it("G.3 happy path forwards the raw session + derived slug to the platform", async () => {
    cookieJar.token = await sessionToken();
    const res = await POST(req({ name: "Dragon Flyer!", html: HTML, pin: "4321" }));
    expect(res.status).toBe(200);
    expect((await res.json()).url).toContain("dragon-flyer");
    expect(platformCalls[0]).toMatchObject({ slug: "dragon-flyer", sessionToken: cookieJar.token });
  });

  it("G.4 name check needs no PIN/session and returns the derived slug", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 200, json: async () => ({ free: true, suggestions: [] }) })));
    const res = await POST(req({ check: true, name: "Super Star Race" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ slug: "super-star-race", free: true });
  });

  it("G.5 unusable name → friendly 422", async () => {
    const res = await POST(req({ name: "🎮", html: HTML, pin: "4321" }));
    expect(res.status).toBe(422);
  });
});
