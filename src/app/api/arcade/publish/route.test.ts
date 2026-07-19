/** Gate tests for the arcade publish bridge: SSO session + PIN-verified
 *  parent-session cookie with OWNERSHIP match (the fix for "any parent can
 *  approve any kid's publish"). Fail-closed. */
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
// Session above keys as user:Agilan (name fallback — no email in the token).
const FAMILY = "user:Agilan";

const req = (body: unknown) => ({ json: async () => body }) as never;
const HTML = "<html><body>Score: 1</body></html>";

let platformCalls: unknown[];
beforeEach(() => {
  platformCalls = [];
  for (const k of Object.keys(cookieJar)) delete cookieJar[k];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    platformCalls.push(JSON.parse(init.body));
    return { status: 200, json: async () => ({ url: "https://dragon-flyer.ariantra.com/", version: "v1" }) };
  }));
});

describe("arcade publish gates", () => {
  it("G.1 no parent-session cookie → 403 parent_required, platform never called", async () => {
    cookieJar.ariantra_session = await sessionToken();
    const res = await POST(req({ name: "Dragon Flyer", html: HTML }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("parent_required");
    expect(platformCalls).toHaveLength(0);
  });

  it("G.2 signed out (no session cookie) → 401, platform never called", async () => {
    const res = await POST(req({ name: "Dragon Flyer", html: HTML }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("signed_out");
    expect(platformCalls).toHaveLength(0);
  });

  it("G.3 happy path: matching parent session forwards raw session + slug to the platform", async () => {
    cookieJar.ariantra_session = await sessionToken();
    cookieJar[PARENT_SESSION_COOKIE] = await mintParentSession(FAMILY, SECRET);
    const res = await POST(req({ name: "Dragon Flyer!", html: HTML }));
    expect(res.status).toBe(200);
    expect((await res.json()).url).toContain("dragon-flyer");
    expect(platformCalls[0]).toMatchObject({ slug: "dragon-flyer", sessionToken: cookieJar.ariantra_session });
  });

  it("G.3b OWNERSHIP: a parent session from ANOTHER family → 403 (§12 cross-family test)", async () => {
    cookieJar.ariantra_session = await sessionToken();
    cookieJar[PARENT_SESSION_COOKIE] = await mintParentSession("user:other-family@example.com", SECRET);
    const res = await POST(req({ name: "Dragon Flyer", html: HTML }));
    expect(res.status).toBe(403);
    expect(platformCalls).toHaveLength(0);
  });

  it("G.3c partner 403 (secret mismatch / wrong ARIANTRA_API_BASE) is NOT parent_required — 502, distinct error (BUG-FIX-LOG 2026-07-11)", async () => {
    // Gates pass; the PLATFORM rejects our x-admin-secret. Forwarding that
    // 403 verbatim made the UI silently re-ask the PIN forever.
    cookieJar.ariantra_session = await sessionToken();
    cookieJar[PARENT_SESSION_COOKIE] = await mintParentSession(FAMILY, SECRET);
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 403, json: async () => { throw new Error("not json"); } })));
    const res = await POST(req({ name: "Dragon Flyer", html: HTML }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).not.toBe("parent_required");
  });

  it("G.4 name check needs no gates and returns the derived slug", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 200, json: async () => ({ free: true, suggestions: [] }) })));
    const res = await POST(req({ check: true, name: "Super Star Race" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ slug: "super-star-race", free: true });
  });

  it("G.5 unusable name → friendly 422", async () => {
    const res = await POST(req({ name: "🎮", html: HTML }));
    expect(res.status).toBe(422);
  });
});

// Owner UAT 2026-07-18: "when i push to arcade there is no way to start the
// multiplayer game" — Ari's publish never told the platform the game is
// multiplayer, so seo.multiplayer stayed false and the published page got no
// 🎮 lobby overlay at all. The flag is now derived from the same
// <!--USES_MULTIPLAYER--> marker the preview's Invite button keys off.
describe("arcade publish — multiplayer flag derived from the marker", () => {
  const MP_HTML = "<html><body><!--USES_MULTIPLAYER--><script>Ariantra.broadcast({})</script></body></html>";

  it("G.6 kid chose multiplayer AND the game carries USES_MULTIPLAYER → seo.multiplayer=true", async () => {
    cookieJar.ariantra_session = await sessionToken();
    cookieJar[PARENT_SESSION_COOKIE] = await mintParentSession(FAMILY, SECRET);
    const res = await POST(req({ name: "Race Together", html: MP_HTML, multiplayer: true }));
    expect(res.status).toBe(200);
    expect(platformCalls[0]).toMatchObject({ seo: { multiplayer: true } });
  });

  it("G.7 a single-player game sends NO multiplayer flag (never flips an existing game off)", async () => {
    cookieJar.ariantra_session = await sessionToken();
    cookieJar[PARENT_SESSION_COOKIE] = await mintParentSession(FAMILY, SECRET);
    const res = await POST(req({ name: "Solo Maze", html: HTML, multiplayer: false }));
    expect(res.status).toBe(200);
    expect((platformCalls[0] as { seo?: unknown }).seo).toBeUndefined();
  });

  it("G.8 kid chose single player → no flag even when the marker exists (explicit choice wins)", async () => {
    cookieJar.ariantra_session = await sessionToken();
    cookieJar[PARENT_SESSION_COOKIE] = await mintParentSession(FAMILY, SECRET);
    const res = await POST(req({ name: "Race Alone", html: MP_HTML, multiplayer: false }));
    expect(res.status).toBe(200);
    expect((platformCalls[0] as { seo?: unknown }).seo).toBeUndefined();
  });

  it("G.9 choosing multiplayer WITHOUT multiplayer code in the game sends no flag (no dead lobby)", async () => {
    cookieJar.ariantra_session = await sessionToken();
    cookieJar[PARENT_SESSION_COOKIE] = await mintParentSession(FAMILY, SECRET);
    const res = await POST(req({ name: "Solo Maze", html: HTML, multiplayer: true }));
    expect(res.status).toBe(200);
    expect((platformCalls[0] as { seo?: unknown }).seo).toBeUndefined();
  });
});

// Owner ask 2026-07-18: "when we push to arcade from preview page, they
// should choose a category and not arcade" — the kid's category rides along
// to the platform; invalid/absent values are dropped (platform then keeps
// its own default) rather than blocking a publish.
describe("arcade publish — category forwarded", () => {
  it("G.10 a valid category is forwarded to the platform", async () => {
    cookieJar.ariantra_session = await sessionToken();
    cookieJar[PARENT_SESSION_COOKIE] = await mintParentSession(FAMILY, SECRET);
    const res = await POST(req({ name: "Fish Maze", html: HTML, category: "Puzzle" }));
    expect(res.status).toBe(200);
    expect(platformCalls[0]).toMatchObject({ category: "Puzzle" });
  });

  it("G.11 an unknown category is dropped, publish still succeeds", async () => {
    cookieJar.ariantra_session = await sessionToken();
    cookieJar[PARENT_SESSION_COOKIE] = await mintParentSession(FAMILY, SECRET);
    const res = await POST(req({ name: "Fish Maze", html: HTML, category: "NotACategory" }));
    expect(res.status).toBe(200);
    expect((platformCalls[0] as { category?: unknown }).category).toBeUndefined();
  });
});
