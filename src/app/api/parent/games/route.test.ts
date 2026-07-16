/** Gate tests for the Parent-zone multiplayer toggle bridge (PRD-MULTIPLAYER.md
 *  Phase 4 — "zero toggle precedent to model after", built here for the first
 *  time). Listing is SSO-session only (same as arcade/publish's list mode);
 *  the actual toggle mutation additionally requires a PIN-verified parent of
 *  THIS family (mirrors arcade/publish's ownership-matched parent gate). */
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
import { mintParentSession, PARENT_SESSION_COOKIE } from "@/lib/parent-session";

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
const FAMILY = "user:Agilan";

const req = (body: unknown) => ({ json: async () => body }) as never;

let platformCalls: unknown[];
beforeEach(() => {
  platformCalls = [];
  for (const k of Object.keys(cookieJar)) delete cookieJar[k];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    platformCalls.push(JSON.parse(init.body));
    return { status: 200, json: async () => ({ games: [{ slug: "dragon-flyer", name: "Dragon Flyer", status: "published", multiplayer: false }] }) };
  }));
});

describe("parent games — list (SSO session only)", () => {
  it("L.1 signed out → 401, platform never called", async () => {
    const res = await POST(req({ list: true }));
    expect(res.status).toBe(401);
    expect(platformCalls).toHaveLength(0);
  });

  it("L.2 signed in (no parent PIN needed) → the family's games", async () => {
    cookieJar.ariantra_session = await sessionToken();
    const res = await POST(req({ list: true }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.games[0].slug).toBe("dragon-flyer");
  });
});

describe("parent games — toggleMultiplayer (parent-PIN gated, same shape as publish)", () => {
  it("T.1 signed out → 401, platform never called", async () => {
    const res = await POST(req({ toggleMultiplayer: true, slug: "dragon-flyer", multiplayer: true }));
    expect(res.status).toBe(401);
    expect(platformCalls).toHaveLength(0);
  });

  it("T.2 no parent-session cookie → 403 parent_required, platform never called", async () => {
    cookieJar.ariantra_session = await sessionToken();
    const res = await POST(req({ toggleMultiplayer: true, slug: "dragon-flyer", multiplayer: true }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("parent_required");
    expect(platformCalls).toHaveLength(0);
  });

  it("T.3 a parent session from ANOTHER family → 403, platform never called", async () => {
    cookieJar.ariantra_session = await sessionToken();
    cookieJar[PARENT_SESSION_COOKIE] = await mintParentSession("user:other-family@example.com", SECRET);
    const res = await POST(req({ toggleMultiplayer: true, slug: "dragon-flyer", multiplayer: true }));
    expect(res.status).toBe(403);
    expect(platformCalls).toHaveLength(0);
  });

  it("T.4 happy path: matching parent session forwards the toggle to the platform", async () => {
    cookieJar.ariantra_session = await sessionToken();
    cookieJar[PARENT_SESSION_COOKIE] = await mintParentSession(FAMILY, SECRET);
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      platformCalls.push(JSON.parse(init.body));
      return { status: 200, json: async () => ({ slug: "dragon-flyer", multiplayer: true }) };
    }));
    const res = await POST(req({ toggleMultiplayer: true, slug: "dragon-flyer", multiplayer: true }));
    expect(res.status).toBe(200);
    expect((await res.json()).multiplayer).toBe(true);
    expect(platformCalls[0]).toMatchObject({ toggleMultiplayer: true, slug: "dragon-flyer", multiplayer: true, sessionToken: cookieJar.ariantra_session });
  });
});
