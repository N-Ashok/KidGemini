/** /api/parent/screen-time — parent-session gated (same gate as /api/alerts,
 *  no freshness requirement: a number isn't a credential).
 *  PRD-SCREEN-TIME-CAP-MVP Part B. AUTH CODE — fail closed. */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

const cookieJar: Record<string, string> = {};
vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) => (cookieJar[name] ? { value: cookieJar[name] } : undefined),
  }),
}));
vi.mock("server-only", () => ({}));

interface SettingsRow { accountId: string; dailyCapMinutes: number | null; updatedAt: number }
interface DailyRow { accountId: string; dayStart: number; activeMinutes: number; alertedAt: number | null; updatedAt: number }

const settingsRows = new Map<string, SettingsRow>();
const dailyRows = new Map<string, DailyRow>();

vi.mock("@/lib/db", () => ({
  SqliteScreenTimeStore: class {
    getSettings(accountId: string) {
      return settingsRows.get(accountId) ?? null;
    }
    putSettings(accountId: string, dailyCapMinutes: number | null) {
      const row = { accountId, dailyCapMinutes, updatedAt: Date.now() };
      settingsRows.set(accountId, row);
      return row;
    }
    getToday(accountId: string, dayStart: number) {
      return dailyRows.get(`${accountId}:${dayStart}`) ?? null;
    }
    recomputeAndMaybeAlert() {
      /* not exercised via this route */
    }
  },
}));

import { GET, POST } from "./route";
import { mintParentSession, PARENT_SESSION_COOKIE } from "@/lib/parent-session";
import { utcDayStart } from "@/lib/screen-time";

const SECRET = "test-secret-long-enough-0123456789";
const OLD_SECRET = process.env.AUTH_JWT_SECRET;
process.env.AUTH_JWT_SECRET = SECRET;
afterAll(() => {
  process.env.AUTH_JWT_SECRET = OLD_SECRET;
});

const ACCOUNT = "user:parent@example.com";
const getReq = () => ({}) as never;
const postReq = (body: unknown) => ({ json: async () => body }) as never;

async function signIn() {
  cookieJar[PARENT_SESSION_COOKIE] = await mintParentSession(ACCOUNT, SECRET);
}

beforeEach(() => {
  for (const k of Object.keys(cookieJar)) delete cookieJar[k];
  settingsRows.clear();
  dailyRows.clear();
});

describe("GET /api/parent/screen-time", () => {
  it("G.1 no parent-session cookie → 401", async () => {
    expect((await GET(getReq())).status).toBe(401);
  });

  it("G.2 no cap set yet → dailyCapMinutes null, today defaults to 0", async () => {
    await signIn();
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dailyCapMinutes).toBeNull();
    expect(body.todayActiveMinutes).toBe(0);
    expect(typeof body.dayStart).toBe("number");
  });

  it("G.3 reflects a saved cap and today's stored tally", async () => {
    await signIn();
    settingsRows.set(ACCOUNT, { accountId: ACCOUNT, dailyCapMinutes: 45, updatedAt: Date.now() });
    const dayStart = utcDayStart(Date.now());
    dailyRows.set(`${ACCOUNT}:${dayStart}`, { accountId: ACCOUNT, dayStart, activeMinutes: 12, alertedAt: null, updatedAt: Date.now() });

    const res = await GET(getReq());
    const body = await res.json();
    expect(body.dailyCapMinutes).toBe(45);
    expect(body.todayActiveMinutes).toBe(12);
    expect(body.dayStart).toBe(dayStart);
  });
});

describe("POST /api/parent/screen-time", () => {
  it("P.1 no parent-session cookie → 401, nothing written", async () => {
    const res = await POST(postReq({ dailyCapMinutes: 30 }));
    expect(res.status).toBe(401);
    expect(settingsRows.size).toBe(0);
  });

  it("P.2 missing dailyCapMinutes field → 400 bad_request", async () => {
    await signIn();
    const res = await POST(postReq({}));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_request");
  });

  it("P.3 rejects invalid values → 422 with a friendly message", async () => {
    await signIn();
    for (const bad of [0, -5, 1441, 3.5, "30", true, {}]) {
      const res = await POST(postReq({ dailyCapMinutes: bad }));
      expect(res.status).toBe(422);
      expect((await res.json()).error).toBe("invalid_cap");
    }
    expect(settingsRows.size).toBe(0);
  });

  it("P.4 accepts a valid integer cap and returns the fresh tally", async () => {
    await signIn();
    const res = await POST(postReq({ dailyCapMinutes: 60 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, dailyCapMinutes: 60, todayActiveMinutes: 0 });
    expect(settingsRows.get(ACCOUNT)?.dailyCapMinutes).toBe(60);
  });

  it("P.5 accepts null to clear an existing cap", async () => {
    await signIn();
    settingsRows.set(ACCOUNT, { accountId: ACCOUNT, dailyCapMinutes: 60, updatedAt: Date.now() });
    const res = await POST(postReq({ dailyCapMinutes: null }));
    expect(res.status).toBe(200);
    expect((await res.json()).dailyCapMinutes).toBeNull();
    expect(settingsRows.get(ACCOUNT)?.dailyCapMinutes).toBeNull();
  });

  it("P.6 round-trips through a subsequent GET", async () => {
    await signIn();
    await POST(postReq({ dailyCapMinutes: 25 }));
    const res = await GET(getReq());
    expect((await res.json()).dailyCapMinutes).toBe(25);
  });
});
