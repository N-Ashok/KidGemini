/** Gate tests for the "invite a friend to test" bridge (PRD-MULTIPLAYER.md
 *  Phase 4). Only Gate 1 (SSO session) — deliberately NO parent-PIN gate,
 *  unlike /api/arcade/publish: nothing is published, no Game record, no
 *  catalog listing, so this doesn't carry the same "goes on the public
 *  internet permanently" stakes a real publish does. */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { SignJWT } from "jose";

const cookieJar: Record<string, string> = {};
vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) => (cookieJar[name] ? { value: cookieJar[name] } : undefined),
  }),
}));
vi.mock("server-only", () => ({}));

import { POST } from "./route";

const SECRET = "test-secret-long-enough-0123456789";
const OLD = { secret: process.env.AUTH_JWT_SECRET };
process.env.AUTH_JWT_SECRET = SECRET;

afterAll(() => {
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
  for (const k of Object.keys(cookieJar)) delete cookieJar[k];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    platformCalls.push(JSON.parse(init.body));
    return { status: 200, json: async () => ({ id: "abc123", url: "https://api.ariantra.com/t/abc123" }) };
  }));
});

describe("arcade test-link gates", () => {
  it("T.1 signed out (no session cookie) → 401, platform never called", async () => {
    const res = await POST(req({ name: "Dragon Flyer", html: HTML }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("signed_out");
    expect(platformCalls).toHaveLength(0);
  });

  it("T.2 happy path: NO parent-session cookie needed, forwards the raw session + html", async () => {
    cookieJar.ariantra_session = await sessionToken();
    const res = await POST(req({ name: "Dragon Flyer", html: HTML }));
    expect(res.status).toBe(200);
    expect((await res.json()).url).toContain("/t/abc123");
    expect(platformCalls[0]).toMatchObject({ createTestLink: true, sessionToken: cookieJar.ariantra_session, html: HTML });
  });

  it("T.3 empty/missing html → friendly 422, platform never called", async () => {
    cookieJar.ariantra_session = await sessionToken();
    const res = await POST(req({ name: "Dragon Flyer" }));
    expect(res.status).toBe(422);
    expect(platformCalls).toHaveLength(0);
  });

  it("T.4 partner secret mismatch → 502, distinct from signed_out/generic errors (mirrors BUG-FIX-LOG 2026-07-11's publish-route fix)", async () => {
    cookieJar.ariantra_session = await sessionToken();
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 403, json: async () => { throw new Error("not json"); } })));
    const res = await POST(req({ name: "Dragon Flyer", html: HTML }));
    expect(res.status).toBe(502);
  });
});
