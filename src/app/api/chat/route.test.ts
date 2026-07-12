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
const replyStreamMock = vi.fn();
const extractArtifactMock = vi.fn((t: string): { text: string; artifactHtml?: string } => ({ text: t, artifactHtml: undefined }));
vi.mock("@/lib/gemini", () => ({
  GeminiChatModel: class {
    replyStream(...args: unknown[]) {
      return replyStreamMock(...args);
    }
  },
  extractArtifact: (t: string) => extractArtifactMock(t),
}));

// Asset injection (3D engine import map) — toggled per test (P.1/P.2).
const injectMock = vi.fn((html: string): { html: string; referencedUrls: string[] } => ({ html, referencedUrls: [] }));
vi.mock("@/lib/assets/inject", () => ({
  injectAssets: (html: string) => injectMock(html),
}));

// Input rules classifier — always allow (we're testing the gate, not safety).
// The Flash-Lite classifier is gone from this route entirely (2026-07-09):
// output safety = Gemini built-in blocking + child-safety system prompt.
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
  yield { kind: "delta", text };
}

/** A builder-style stream: thought summaries first, then the answer. */
async function* withThoughts(thoughts: string[], text: string) {
  for (const t of thoughts) yield { kind: "thought", text: t };
  yield { kind: "delta", text };
}

beforeEach(() => {
  authMock.mockReset();
  replyStreamMock.mockReset();
  extractArtifactMock.mockReset();
  extractArtifactMock.mockImplementation((t: string) => ({ text: t, artifactHtml: undefined }));
  injectMock.mockReset();
  injectMock.mockImplementation((html: string) => ({ html, referencedUrls: [] }));
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

describe("POST /api/chat — no post-hoc safety retraction (chess-block class, 2026-07-09)", () => {
  it("R.1 a streamed game reaches 'done' and is NEVER followed by a retract event", async () => {
    authMock.mockResolvedValue(null);
    replyStreamMock.mockReturnValue(one("Here's chess! ```html<!doctype html>...```"));

    const res = await POST(makeReq({ message: "make me a chess game", history: [] }));

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"type":"done"');
    expect(text).not.toContain('"type":"retract"');
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

describe("POST /api/chat — asset injection can never cost the child the game (P-class, BUG-FIX-LOG 2026-07-08)", () => {
  const RAW_GAME = "<!doctype html><html><head></head><body><!--USES_THREE-->game</body></html>";

  beforeEach(() => {
    authMock.mockResolvedValue(null);
    replyStreamMock.mockReturnValue(one("```html" + RAW_GAME + "```"));
    extractArtifactMock.mockImplementation(() => ({ text: "Here's your game! 🎮", artifactHtml: RAW_GAME }));
  });

  it("P.1 injector throws → 'done' still carries the RAW artifact (preview must open)", async () => {
    injectMock.mockImplementation(() => {
      throw new Error("manifest has no engine entry");
    });

    const res = await POST(makeReq({ message: "make me a 3d game", history: [] }));
    const text = await res.text();

    const done = JSON.parse(text.trim().split("\n").find((l) => l.includes('"done"'))!);
    expect(done.artifactHtml).toBe(RAW_GAME);
  });

  it("P.2 injection success → 'done' carries the injected html", async () => {
    const INJECTED = RAW_GAME.replace("<!--USES_THREE-->", '<script type="importmap">{"imports":{"three":"https://assets.ariantra.com/three.b4a9d4.js"}}</script>');
    injectMock.mockImplementation(() => ({ html: INJECTED, referencedUrls: ["https://assets.ariantra.com/three.b4a9d4.js"] }));

    const res = await POST(makeReq({ message: "make me a 3d game", history: [] }));
    const text = await res.text();

    const done = JSON.parse(text.trim().split("\n").find((l) => l.includes('"done"'))!);
    expect(done.artifactHtml).toBe(INJECTED);
    expect(injectMock).toHaveBeenCalledWith(RAW_GAME);
  });

  it("P.3 no artifact in the reply → injector is never called", async () => {
    extractArtifactMock.mockImplementation((t: string) => ({ text: t, artifactHtml: undefined }));

    const res = await POST(makeReq({ message: "hello", history: [] }));
    await res.text();

    expect(injectMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/chat — thought summaries → kid-facing thinking events (2026-07-11)", () => {
  it("T.1 clean thoughts stream as thinking events and never leak into the answer", async () => {
    authMock.mockResolvedValue(null);
    replyStreamMock.mockReturnValue(
      withThoughts(["I'll design the maze layout with fun obstacles first."], "Here is your game!"),
    );

    const res = await POST(makeReq({ message: "make me a maze game", history: [] }));
    const text = await res.text();

    expect(text).toContain('"type":"thinking"');
    expect(text).toContain("maze layout");
    const done = JSON.parse(text.trim().split("\n").find((l) => l.includes('"done"'))!);
    expect(done.text).toBe("Here is your game!"); // thought text excluded from the reply
  });

  it("T.2 code-like thoughts are dropped — a kid never sees raw code in the planning line", async () => {
    authMock.mockResolvedValue(null);
    replyStreamMock.mockReturnValue(withThoughts(["const player = { x: 0, y: 0 };"], "Hello!"));

    const res = await POST(makeReq({ message: "make me a game", history: [] }));
    const text = await res.text();

    expect(text).not.toContain('"type":"thinking"');
    expect(text).toContain('"type":"done"');
  });
});
