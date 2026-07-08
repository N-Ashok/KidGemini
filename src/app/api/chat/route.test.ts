// Integration tests for the /api/chat gate funnel (CLAUDE.md §7.4).
// Contract (guest trial restored — PRD "guest gate", layered abuse control):
//   guest under limits            → streams (Gemini called), guest cookie set
//   guest over DEVICE limit (10K) → 401 auth_required  (sign-in wall)
//   guest IP over the IP cap      → 401 auth_required  (cookie-clearing backstop)
//   IP rate-limit block           → 429 rate_limited   (slow down)
//   IP struck out (3 strikes)     → 402 payment_required (paywall)
//   signed-in, budget off (0)     → streams (unlimited)
//   signed-in over daily budget   → 402 payment_required (config-ready, off by default)
// Every block travels as an HTTP STATUS (silent-hang prevention class — BUG-FIX-LOG 2026-06-25);
// Gemini is NEVER called on any blocked path.
//
// Collaborators are mocked so no real Gemini, SQLite, or log file is touched.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// getAriantraSession() — toggled per test (SSO session).
const authMock = vi.fn();
vi.mock("@/lib/ariantra-session.server", () => ({ getAriantraSession: () => authMock() }));

vi.mock("@/lib/logger", () => ({}));
vi.mock("server-only", () => ({}));

// Gemini — spy so we can assert it is NEVER called on blocked paths.
// extractArtifact delegates to a mock so game-bearing replies can be simulated.
const replyStreamMock = vi.fn();
const extractArtifactMock = vi.fn(
  (t: string): { text: string; artifactHtml?: string } => ({ text: t, artifactHtml: undefined }),
);
vi.mock("@/lib/gemini", () => ({
  GeminiChatModel: class {
    replyStream(...args: unknown[]) {
      return replyStreamMock(...args);
    }
  },
  extractArtifact: (t: string) => extractArtifactMock(t),
}));

// Three.js injector — overridable so a test can simulate it THROWING (the real
// one reads a vendored file off disk, which the deploy once didn't ship —
// BUG-FIX-LOG 2026-07-08: post-processing must never cost the child the game).
const injectThreeMock = vi.fn((html: string) => html);
vi.mock("@/lib/three-vendor", () => ({
  injectThreeJsIfNeeded: (html: string) => injectThreeMock(html),
}));

// Safety classifiers — always allow (we're testing the gate, not safety).
vi.mock("@/lib/safety", () => ({
  FlashLiteClassifier: class {
    async classify() {
      return { category: null, severity: "low", action: "allow", reason: "" };
    }
  },
}));
vi.mock("@/lib/safety.rules", () => ({
  RulesClassifier: class {
    classifySync() {
      return { category: null, severity: "low", action: "allow", reason: "" };
    }
  },
}));

// Geo — a stable IP so the IP-layer gates are exercised.
vi.mock("@/lib/geo", () => ({ resolveGeo: () => ({ ip: "203.0.113.9", country: null, region: null, city: null }) }));

// DB stores — knobs the tests turn.
const usedByUser = vi.fn((..._a: unknown[]): number => 0); // device tally (guests, windowed)
const usedByIp = vi.fn((..._a: unknown[]): number => 0); // guest tokens across an IP (windowed)
const usedByUserSince = vi.fn((): number => 0); // signed-in daily tally
const rateHit = vi.fn((): { state: string; mustPay?: boolean; until?: number } => ({ state: "ok" }));
vi.mock("@/lib/db", () => ({
  SqliteAlertStore: class {
    record() {}
  },
  SqliteUsageStore: class {
    record() {}
    tokensUsedByUser(...a: unknown[]) {
      return usedByUser(...a);
    }
    guestTokensUsedByIp(...a: unknown[]) {
      return usedByIp(...a);
    }
    tokensUsedByUserSince() {
      return usedByUserSince();
    }
  },
  SqliteRateLimitStore: class {
    hit() {
      return rateHit();
    }
  },
}));

import { POST } from "./route";
import { GUEST_TOKEN_LIMIT, IP_GUEST_TOKEN_CAP, GUEST_WINDOW_MS, SIGNED_IN_DAILY_TOKEN_LIMIT } from "@/lib/gate.config";

function makeReq(body: unknown): import("next/server").NextRequest {
  return {
    json: async () => body,
    headers: new Headers(),
    cookies: { get: () => undefined },
  } as unknown as import("next/server").NextRequest;
}

async function* one(text: string) {
  yield text;
}

beforeEach(() => {
  authMock.mockReset();
  replyStreamMock.mockReset();
  extractArtifactMock.mockReset();
  extractArtifactMock.mockImplementation((t: string) => ({ text: t, artifactHtml: undefined }));
  injectThreeMock.mockReset();
  injectThreeMock.mockImplementation((html: string) => html);
  usedByUser.mockReturnValue(0);
  usedByIp.mockReturnValue(0);
  usedByUserSince.mockReturnValue(0);
  rateHit.mockReturnValue({ state: "ok" });
});

afterEach(() => {
  delete process.env.SIGNED_IN_DAILY_TOKEN_LIMIT;
});

describe("POST /api/chat — guest trial (10K) with layered abuse control", () => {
  it("G.1 a fresh guest streams and gets a device cookie", async () => {
    authMock.mockResolvedValue(null);
    replyStreamMock.mockReturnValue(one("Hello!"));

    const res = await POST(makeReq({ message: "hello", history: [] }));

    expect(res.status).toBe(200);
    expect(replyStreamMock).toHaveBeenCalledTimes(1);
    expect(res.headers.get("set-cookie")).toContain("kg_guest=");
    expect(await res.text()).toContain('"type":"done"');
  });

  it("G.2 guest over the 10K device limit → 401 sign-in wall, Gemini never called", async () => {
    authMock.mockResolvedValue(null);
    usedByUser.mockReturnValue(GUEST_TOKEN_LIMIT);

    const res = await POST(makeReq({ message: "hello", history: [] }));

    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("auth_required");
    expect(replyStreamMock).not.toHaveBeenCalled();
  });

  it("G.3 fresh cookie but IP over the IP cap → 401 (cookie-clearing does not reset the trial)", async () => {
    authMock.mockResolvedValue(null);
    usedByUser.mockReturnValue(0); // brand-new device cookie
    usedByIp.mockReturnValue(IP_GUEST_TOKEN_CAP); // …but the IP already spent its share

    const res = await POST(makeReq({ message: "hello", history: [] }));

    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("auth_required");
    expect(replyStreamMock).not.toHaveBeenCalled();
  });

  it("G.5 the guest tallies use a rolling 2-day window (limit RESETS — not lifetime)", async () => {
    authMock.mockResolvedValue(null);
    replyStreamMock.mockReturnValue(one("Hello!"));

    await POST(makeReq({ message: "hello", history: [] }));

    expect(GUEST_WINDOW_MS).toBe(2 * 24 * 60 * 60 * 1000);
    const since = usedByUser.mock.calls[0]![1] as number;
    expect(since).toBeGreaterThan(Date.now() - GUEST_WINDOW_MS - 5_000);
    expect(since).toBeLessThanOrEqual(Date.now() - GUEST_WINDOW_MS + 5_000);
    const ipSince = usedByIp.mock.calls[0]![1] as number;
    expect(ipSince).toBeCloseTo(since, -3);
  });

  it("G.4 rate-limited IP → 429; struck-out IP → 402 paywall", async () => {
    authMock.mockResolvedValue(null);

    rateHit.mockReturnValue({ state: "blocked", mustPay: false, until: Date.now() + 1000 });
    const limited = await POST(makeReq({ message: "hello", history: [] }));
    expect(limited.status).toBe(429);
    expect((await limited.json()).error).toBe("rate_limited");

    rateHit.mockReturnValue({ state: "blocked", mustPay: true, until: Date.now() + 1000 });
    const struck = await POST(makeReq({ message: "hello", history: [] }));
    expect(struck.status).toBe(402);
    expect((await struck.json()).error).toBe("payment_required");

    expect(replyStreamMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/chat — signed-in users", () => {
  const SESSION = { userId: "user:kid@example.com", email: "kid@example.com", name: "Kid" };

  it("S.1 config default keeps the paid budget OFF (0 = unlimited)", () => {
    expect(SIGNED_IN_DAILY_TOKEN_LIMIT).toBe(0);
  });

  it("S.2 streams with the daily budget off, regardless of usage", async () => {
    authMock.mockResolvedValue(SESSION);
    replyStreamMock.mockReturnValue(one("Hi there!"));
    usedByUserSince.mockReturnValue(999_999_999); // irrelevant while the knob is 0

    const res = await POST(makeReq({ message: "hello", history: [] }));

    expect(res.status).toBe(200);
    expect(replyStreamMock).toHaveBeenCalledTimes(1);
    const text = await res.text();
    expect(text).toContain('"type":"delta"');
    expect(text).toContain('"type":"done"');
  });

  it("S.3 over the daily budget (env knob > 0) → 402 payment_required, Gemini never called", async () => {
    process.env.SIGNED_IN_DAILY_TOKEN_LIMIT = "50000";
    authMock.mockResolvedValue(SESSION);
    usedByUserSince.mockReturnValue(50_000);

    const res = await POST(makeReq({ message: "hello", history: [] }));

    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe("payment_required");
    expect(replyStreamMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/chat — game post-processing can never cost the child the game (BUG-FIX-LOG 2026-07-08)", () => {
  const GAME = "<html><body>THE GAME</body></html>";

  function gameReply() {
    authMock.mockResolvedValue(null);
    replyStreamMock.mockReturnValue(one("Here's your game!"));
    extractArtifactMock.mockImplementation((t: string) => ({ text: t, artifactHtml: GAME }));
  }

  it("P.1 'done' still carries the (uninjected) game when the Three.js injector throws", async () => {
    gameReply();
    // The real injector reads a vendored file off disk — which the deploy
    // didn't ship, so in prod this threw ENOENT and the done event was lost:
    // code streamed as text, the preview never opened.
    injectThreeMock.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory, open 'src/lib/vendor/three-bundle.generated.js'");
    });

    const res = await POST(makeReq({ message: "make me a 3d game", history: [] }));

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"type":"done"');
    expect(text).toContain("THE GAME"); // fell back to the raw artifact — preview opens
  });

  it("P.2 the injected html is delivered when injection succeeds", async () => {
    gameReply();
    injectThreeMock.mockImplementation((html: string) => html.replace("THE GAME", "THE GAME + THREE"));

    const res = await POST(makeReq({ message: "make me a 3d game", history: [] }));

    expect(await res.text()).toContain("THE GAME + THREE");
  });
});
