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
// Real (unmocked) module — the honest kid-facing lines the route substitutes
// when a whole-game rebuild happened (penguin-maze hardening, 2026-07-18).
import { REBUILT_GAME_LINE, FRESH_GAME_LINE } from "@/lib/game-edit";
import { SafetyBlockedError } from "@/lib/model-runner";
import { KIND_REDIRECT, MODEL_GLITCH_RETRY, BUILD_INCOMPLETE_RETRY, BUILD_STARTER_SPLIT, EDIT_FAILED_SOFT } from "@/lib/chat-copy";
// The REAL floor (not mocked): delivery now guarantees the three import map on
// any game that imports "three", even without the <!--USES_THREE--> marker
// (BUG-FIX-LOG 2026-07-23). Tests assert the delivered game === the game floored.
import { ensureAssetRuntime } from "@/lib/assets/ensure-runtime";

// getAriantraSession() — toggled per test (SSO session).
const authMock = vi.fn();
vi.mock("@/lib/ariantra-session.server", () => ({ getAriantraSession: () => authMock() }));

vi.mock("@/lib/logger", () => ({}));
vi.mock("server-only", () => ({}));

// Gemini — spy so we can assert it is NEVER called on blocked paths.
const replyStreamMock = vi.fn();
// One-shot reply — used ONLY by the patch-fallback path (a failed edit-patch
// falls back to a full regeneration, BUG-FIX-LOG class fix 2026-07-18).
const replyMock = vi.fn();
// Hunks-only retry when the model answered an edit turn with a full rewrite
// (penguin-maze hardening, 2026-07-18): one bounded second chance to express
// the change as a patch before the rewrite is accepted.
const strictEditRetryMock = vi.fn();
const extractArtifactMock = vi.fn((t: string): { text: string; artifactHtml?: string } => ({ text: t, artifactHtml: undefined }));
vi.mock("@/lib/gemini", () => ({
  GeminiChatModel: class {
    replyStream(...args: unknown[]) {
      return replyStreamMock(...args);
    }
    reply(...args: unknown[]) {
      return replyMock(...args);
    }
    strictEditRetry(...args: unknown[]) {
      return strictEditRetryMock(...args);
    }
  },
  extractArtifact: (t: string) => extractArtifactMock(t),
}));

// Asset injection (3D engine import map) — toggled per test (P.1/P.2).
const injectMock = vi.fn((html: string): { html: string; referencedUrls: string[] } => ({ html, referencedUrls: [] }));
vi.mock("@/lib/assets/inject", () => ({
  injectAssets: (html: string) => injectMock(html),
}));

// Input rules classifier — defaults to allow (we're testing the gate, not
// safety), but the verdict is mutable so the input-block path can be exercised.
// The Flash-Lite classifier is gone from this route entirely (2026-07-09):
// output safety = Gemini built-in blocking + child-safety system prompt.
let ruleVerdict: { category: string | null; severity: string; action: string; reason: string } = {
  category: null, severity: "low", action: "allow", reason: "",
};
// Captures what text each call was actually scanned with (KNOWN_BUGS #7/#12
// regression: an attached file's content must never reach this scan).
const classifySyncCalls: Array<{ text: string; origin: string }> = [];
vi.mock("@/lib/safety.rules", () => ({
  RulesClassifier: class {
    classifySync(input: { text: string; origin: string }) {
      classifySyncCalls.push(input);
      return ruleVerdict;
    }
  },
}));

// Geo — a stable IP so the IP-layer gates are exercised.
vi.mock("@/lib/geo", () => ({ resolveGeo: () => ({ ip: "203.0.113.9", country: null, region: null, city: null }) }));

const { fetchGateMock, billSparksMock } = vi.hoisted(() => ({ fetchGateMock: vi.fn(), billSparksMock: vi.fn() }));
vi.mock("@/lib/sparks-bridge", () => ({
  billSparks: (...args: unknown[]) => billSparksMock(...args),
  fetchGate: (token: unknown) => fetchGateMock(token),
}));

// DB stores — knobs the tests turn.
const usedByUser = vi.fn((..._a: unknown[]): number => 0); // device tally (guests, windowed)
const chatTurnsByUser = vi.fn((..._a: unknown[]): number => 0); // guest ask counter (one-ask funnel, 2026-08-08)
const usedByIp = vi.fn((..._a: unknown[]): number => 0); // guest tokens across an IP (windowed)
const usedByUserSince = vi.fn((): number => 0); // signed-in daily tally
const rateHit = vi.fn((): { state: string; mustPay?: boolean; until?: number } => ({ state: "ok" }));
// Usage rows the route recorded (cost metering).
const usageRows: Array<{ outputText?: string; outputTokens?: number }> = [];
// Turn-result capture (resumable generations): what the route persisted.
const turnCalls: Array<{ op: string; replyId: string; userId: string; text?: string; artifactHtml?: string | null }> = [];
// Screen-time ping + recompute calls (PRD-SCREEN-TIME-CAP-MVP Part B).
const screenTimePings: string[] = [];
const screenTimeCalls: Array<{ accountId: string; userLabel: string | null }> = [];
let screenTimeThrows = false;
vi.mock("@/lib/db", () => ({
  SqliteAlertStore: class {
    record() {}
  },
  SqliteScreenTimeStore: class {
    recordPing(accountId: string) {
      if (screenTimeThrows) throw new Error("boom");
      screenTimePings.push(accountId);
    }
    recomputeAndMaybeAlert(accountId: string, userLabel: string | null) {
      screenTimeCalls.push({ accountId, userLabel });
    }
  },
  SqliteTurnResultStore: class {
    start(replyId: string, userId: string) {
      turnCalls.push({ op: "start", replyId, userId });
    }
    complete(replyId: string, userId: string, text: string, artifactHtml: string | null) {
      turnCalls.push({ op: "complete", replyId, userId, text, artifactHtml });
    }
    fail(replyId: string, userId: string) {
      turnCalls.push({ op: "fail", replyId, userId });
    }
    get() {
      return null;
    }
  },
  SqliteUsageStore: class {
    record(row: { outputText?: string; outputTokens?: number }) {
      usageRows.push(row);
    }
    tokensUsedByUser(...a: unknown[]) {
      return usedByUser(...a);
    }
    chatTurnsByUser(...a: unknown[]) {
      return chatTurnsByUser(...a);
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
import { GUEST_TOKEN_LIMIT, IP_GUEST_TOKEN_CAP, GUEST_WINDOW_MS, SIGNED_IN_DAILY_TOKEN_LIMIT, BIBLE_TEACHER_GUEST_TOKEN_LIMIT } from "@/lib/gate.config";

function makeReq(body: unknown, cookies: Record<string, string> = {}): import("next/server").NextRequest {
  return {
    json: async () => body,
    headers: new Headers(),
    cookies: { get: (name: string) => (name in cookies ? { value: cookies[name] } : undefined) },
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

/** Parses markdown with the SAME stack src/components/Markdown.tsx renders
 *  with (react-markdown → remark-gfm), so a test can assert on how many
 *  distinct `code` mdast nodes a chat message would actually produce — the
 *  repro tool for BUG-FIX-LOG 2026-07-14's "stray code widget" corruption. */
async function codeNodes(markdown: string): Promise<Array<{ lang: string | null; value: string }>> {
  const { unified } = await import("unified");
  const { default: remarkParse } = await import("remark-parse");
  const { default: remarkGfm } = await import("remark-gfm");
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown);
  const out: Array<{ lang: string | null; value: string }> = [];
  const walk = (node: { type: string; lang?: string; value?: string; children?: unknown[] }) => {
    if (node.type === "code") out.push({ lang: node.lang ?? null, value: node.value ?? "" });
    if (node.children) for (const c of node.children) walk(c as typeof node);
  };
  walk(tree as never);
  return out;
}

beforeEach(() => {
  authMock.mockReset();
  chatTurnsByUser.mockReset();
  chatTurnsByUser.mockReturnValue(0);
  fetchGateMock.mockReset();
  fetchGateMock.mockResolvedValue({ status: 200, data: { canStart: true, trialUsed: false } });
  billSparksMock.mockReset();
  replyStreamMock.mockReset();
  replyMock.mockReset();
  strictEditRetryMock.mockReset();
  replyMock.mockResolvedValue({ text: "fallback" });
  extractArtifactMock.mockReset();
  extractArtifactMock.mockImplementation((t: string) => ({ text: t, artifactHtml: undefined }));
  injectMock.mockReset();
  injectMock.mockImplementation((html: string) => ({ html, referencedUrls: [] }));
  usedByUser.mockReturnValue(0);
  usedByIp.mockReturnValue(0);
  usedByUserSince.mockReturnValue(0);
  rateHit.mockReturnValue({ state: "ok" });
  ruleVerdict = { category: null, severity: "low", action: "allow", reason: "" };
  classifySyncCalls.length = 0;
});

afterEach(() => {
  delete process.env.SIGNED_IN_DAILY_TOKEN_LIMIT;
  vi.unstubAllEnvs();
});

describe("POST /api/chat — guest trial (10K) with layered abuse control", () => {
  it("G.1 a fresh guest streams and gets a device cookie under the current (post-rename) name", async () => {
    authMock.mockResolvedValue(null);
    replyStreamMock.mockReturnValue(one("Hello!"));

    const res = await POST(makeReq({ message: "hello", history: [] }));

    expect(res.status).toBe(200);
    expect(replyStreamMock).toHaveBeenCalledTimes(1);
    expect(res.headers.get("set-cookie")).toContain("ari_guest=");
    expect(await res.text()).toContain('"type":"done"');
  });

  // 2026-07-17 rename ("kidgemini" → "Ari"): a returning guest's whole
  // identity/history lives behind this cookie for up to a year — a name
  // change with no fallback would silently reset every existing guest.
  it("G.1b a device carrying only the pre-rename cookie keeps its identity, migrated to the new cookie name", async () => {
    authMock.mockResolvedValue(null);
    replyStreamMock.mockReturnValue(one("Hello!"));
    const existingId = "guest:11111111-1111-1111-1111-111111111111";

    const res = await POST(makeReq({ message: "hello", history: [] }, { kg_guest: existingId }));

    expect(res.status).toBe(200);
    // Same identity carried forward — the token gate's usage lookup ran
    // against the SAME id the legacy cookie already had usage tallied under.
    expect(usedByUser).toHaveBeenCalledWith(existingId, expect.anything());
    // Re-persisted under the new name so future requests stop needing the
    // legacy fallback — never re-minted as a fresh random id.
    expect(res.headers.get("set-cookie")).toContain(`ari_guest=${existingId}`);
  });

  // Guest→account merge gap (BUG-FIX-LOG 2026-07-18): the guest cookie used to
  // be host-only (no Domain=), so a canonical-domain rename
  // (kidgemini.ariantra.com → ari.ariantra.com → games-lab.ariantra.com) mints
  // a brand-new guest identity on the new host and orphans the old one's chats.
  it("G.1c in production, the guest cookie is scoped to the whole apex domain so a subdomain rename doesn't orphan it", async () => {
    vi.stubEnv("NODE_ENV", "production");
    authMock.mockResolvedValue(null);
    replyStreamMock.mockReturnValue(one("Hello!"));

    const res = await POST(makeReq({ message: "hello", history: [] }));

    expect(res.headers.get("set-cookie")).toContain("Domain=.ariantra.com");
  });

  it("G.1d outside production (local dev), the cookie stays host-only — no Domain on http://localhost", async () => {
    vi.stubEnv("NODE_ENV", "test");
    authMock.mockResolvedValue(null);
    replyStreamMock.mockReturnValue(one("Hello!"));

    const res = await POST(makeReq({ message: "hello", history: [] }));

    expect(res.headers.get("set-cookie")).not.toContain("Domain=");
  });

  // Owner funnel 2026-08-08: a signed-out visitor gets exactly ONE ask — the
  // game builds (client locks the preview behind sign-in), and the SECOND ask
  // walls. The token tally stays only as the per-IP backstop and the
  // bible-teacher surface's own trial.
  it("G.6 a guest's SECOND ask → 401 sign-in wall, Gemini never called (one-ask funnel)", async () => {
    authMock.mockResolvedValue(null);
    chatTurnsByUser.mockReturnValue(1); // the one free ask is spent
    usedByUser.mockReturnValue(500); // token tally is irrelevant now

    const res = await POST(makeReq({ message: "make it faster", history: [] }));

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("auth_required");
    expect(body.message).toMatch(/sign in/i);
    expect(replyStreamMock).not.toHaveBeenCalled();
  });

  it("G.6b the FIRST ask still streams (chatTurnsByUser = 0)", async () => {
    authMock.mockResolvedValue(null);
    chatTurnsByUser.mockReturnValue(0);
    replyStreamMock.mockReturnValue(one("Here's your game!"));

    const res = await POST(makeReq({ message: "make a game", history: [] }));

    expect(res.status).toBe(200);
    expect(replyStreamMock).toHaveBeenCalledTimes(1);
  });

  it("G.6c the bible-teacher surface keeps its own token trial — the one-ask rule doesn't apply there", async () => {
    authMock.mockResolvedValue(null);
    chatTurnsByUser.mockReturnValue(3); // would wall on the default surface
    usedByUser.mockReturnValue(0); // but its 2K token trial is untouched
    replyStreamMock.mockReturnValue(one("Hello!"));

    const res = await POST(makeReq({ message: "hello", history: [], persona: "bible-teacher" }));

    expect(res.status).toBe(200);
    expect(replyStreamMock).toHaveBeenCalledTimes(1);
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

// 2026-08-07 owner decision (platform PRD-SPARKS trial amendment): when a
// kid's Sparks run out, the IN-FLIGHT response completes (debits are
// post-usage, so nothing here can cut a stream), but the NEXT turn is
// refused with a buy-Sparks message. Fail OPEN on a platform hiccup — a
// Sparks outage must never stop a kid's turn (mirror of billSparks's
// fire-and-forget stance; money is protected at the ORDER route, not here).
describe("POST /api/chat — Sparks exhaustion gate (2026-08-07)", () => {
  const SESSION = { userId: "user:kid@example.com", email: "kid@example.com", name: "Kid" };
  const COOKIES = { ariantra_session: "jwt-kid" };

  beforeEach(() => {
    authMock.mockResolvedValue(SESSION);
    replyStreamMock.mockReturnValue(one("Here is your game!"));
  });

  it("out of sparks → paywall event with the buy-sparks message, Gemini never called", async () => {
    fetchGateMock.mockResolvedValue({ status: 200, data: { canStart: false, trialUsed: false } });
    const res = await POST(makeReq({ message: "add a boss", history: [] }, COOKIES));
    const text = await res.text();
    expect(text).toContain('"type":"paywall"');
    expect(text).toContain('"sparksOver":true');
    expect(text).toMatch(/buy sparks/i);
    expect(replyStreamMock).not.toHaveBeenCalled();
  });

  it("sparks remaining → the turn streams normally", async () => {
    fetchGateMock.mockResolvedValue({ status: 200, data: { canStart: true, trialUsed: false } });
    const res = await POST(makeReq({ message: "add a boss", history: [] }, COOKIES));
    expect(await res.text()).toContain('"type":"done"');
    expect(replyStreamMock).toHaveBeenCalledTimes(1);
  });

  it("platform gate unreachable → fail OPEN, the turn streams (an outage never blocks a kid)", async () => {
    fetchGateMock.mockResolvedValue({ status: 502, data: {} });
    const res = await POST(makeReq({ message: "add a boss", history: [] }, COOKIES));
    expect(await res.text()).toContain('"type":"done"');
    expect(replyStreamMock).toHaveBeenCalledTimes(1);
  });

  it("guests (no session cookie) are never gated — nothing bills for them either", async () => {
    authMock.mockResolvedValue(null);
    const res = await POST(makeReq({ message: "make a game", history: [] }));
    expect(res.status).toBe(200);
    expect(fetchGateMock).not.toHaveBeenCalled();
  });
});

// docs/PRD-SPARKS.md 3D pricing amendment: a 3D build/edit turn must report
// is3D:true to the platform's billing bridge so it's charged at the 3D rate.
// catalogGates() (assets/catalog-gate.ts) is the REAL, unmocked detector here
// — these tests prove the route actually consumes its result and forwards it
// to billSparks, both for a fresh 3D build (keyword) and an EDIT on an
// existing 3D game (structural marker, no keyword in the edit message itself).
describe("POST /api/chat — 3D pricing (docs/PRD-SPARKS.md)", () => {
  const SESSION = { userId: "user:kid@example.com", email: "kid@example.com", name: "Kid" };
  const COOKIES = { ariantra_session: "jwt-kid" };
  const THREE_GAME =
    '<!doctype html><html><body><!--USES_THREE--><div id="score">0</div></body></html>';

  beforeEach(() => {
    authMock.mockResolvedValue(SESSION);
  });

  it("a fresh '3d' build sends is3D:true on every billed usage row", async () => {
    replyStreamMock.mockReturnValue(one("Here's your 3D game!"));
    const res = await POST(makeReq({ message: "make me a 3d racing game", history: [] }, COOKIES));
    await res.text(); // drain the stream — billing fires as the stream finishes
    expect(res.status).toBe(200);
    expect(billSparksMock).toHaveBeenCalled();
    for (const call of billSparksMock.mock.calls) {
      expect(call[0]).toMatchObject({ is3D: true });
    }
  });

  it("a plain 2D build never sends is3D at all", async () => {
    replyStreamMock.mockReturnValue(one("Here's your game!"));
    const res = await POST(makeReq({ message: "make me a maze game", history: [] }, COOKIES));
    await res.text();
    expect(res.status).toBe(200);
    expect(billSparksMock).toHaveBeenCalled();
    for (const call of billSparksMock.mock.calls) {
      // billSparks's OWN options here carry a plain boolean (route.ts always
      // passes one); sparks-bridge.ts is what omits it from the wire payload
      // when false — see sparks-bridge.test.ts for that contract.
      expect((call[0] as { is3D?: boolean }).is3D).toBeFalsy();
    }
  });

  // The requirement the user explicitly stated: editing an existing 3D game
  // must ALSO bill at the 3D rate, even when the edit request's own text
  // never says "3d" — catalogGates() re-detects 3D-ness from the prior
  // artifact's <!--USES_THREE--> marker, not just the message.
  it("an edit on an existing 3D game sends is3D:true even though the edit message doesn't mention 3D", async () => {
    const historyWithThreeGame = [
      { id: "1", role: "child" as const, text: "make me a 3d game", createdAt: 1 },
      { id: "2", role: "assistant" as const, text: "Here!", artifactHtml: THREE_GAME, createdAt: 2 },
    ];
    replyStreamMock.mockReturnValue(one("Added a boost pad!"));
    const res = await POST(makeReq({ message: "add a boost pad", history: historyWithThreeGame }, COOKIES));
    await res.text();
    expect(res.status).toBe(200);
    expect(billSparksMock).toHaveBeenCalled();
    for (const call of billSparksMock.mock.calls) {
      expect(call[0]).toMatchObject({ is3D: true });
    }
  });

  it("an edit on an existing 2D game (no 3D marker, no 3D keyword) never sends is3D", async () => {
    const historyWith2DGame = [
      { id: "1", role: "child" as const, text: "make me a game", createdAt: 1 },
      {
        id: "2", role: "assistant" as const, text: "Here!",
        artifactHtml: '<!doctype html><html><body><div id="score">0</div></body></html>',
        createdAt: 2,
      },
    ];
    replyStreamMock.mockReturnValue(one("Added a boost pad!"));
    const res = await POST(makeReq({ message: "add a boost pad", history: historyWith2DGame }, COOKIES));
    await res.text();
    expect(res.status).toBe(200);
    expect(billSparksMock).toHaveBeenCalled();
    for (const call of billSparksMock.mock.calls) {
      // billSparks's OWN options here carry a plain boolean (route.ts always
      // passes one); sparks-bridge.ts is what omits it from the wire payload
      // when false — see sparks-bridge.test.ts for that contract.
      expect((call[0] as { is3D?: boolean }).is3D).toBeFalsy();
    }
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
    // injectAssets throwing no longer means an unresolvable 3D game: the raw
    // artifact still gets the import-map floor, so the preview opens AND three
    // resolves. (Floor is independent of injectAssets, so it survives its throw.)
    expect(done.artifactHtml).toBe(ensureAssetRuntime(RAW_GAME));
    expect(done.artifactHtml).toContain('type="importmap"');
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

// Pipeline-bypass guard (BUG_LOG 2026-08-09 "Calvin"). A generated 3D game
// skipped the vendored contract entirely — no <!--USES_THREE--> marker, no
// import map, no `from "three"` — and loaded three r128 off cdnjs with a
// legacy global <script src>. r128 predates CapsuleGeometry, so
// `new THREE.CapsuleGeometry(...)` threw "is not a constructor" on the line
// building the child's own character and the kid got a blank screen after a
// ~70s wait (a model stub + a truncation recovery came first).
//
// The existing three-import lint could not see it: it matches
// `import {...} from "three"` and there was no ES import in the document.
describe("POST /api/chat — a game must never load a library from an external CDN", () => {
  // Calvin's real shape, reduced: the cdnjs tag + a global THREE.* call.
  const CDN_GAME =
    `<!doctype html><html><body><canvas id="gameCanvas"></canvas>\n` +
    `<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>\n` +
    `<script>const g = new THREE.CapsuleGeometry(1.5, 3, 4, 8);</script></body></html>`;
  const CLEAN_GAME =
    `<!doctype html><html><body><!--USES_THREE--><canvas id="scene"></canvas>\n` +
    `<script type="module">import { Scene, CapsuleGeometry } from "three";\nCLEAN GAME</script></body></html>`;

  const doneOf = (text: string) => JSON.parse(text.trim().split("\n").find((l) => l.includes('"done"'))!);

  beforeEach(() => {
    authMock.mockResolvedValue(null);
    replyStreamMock.mockReturnValue(one("Here's your game!\n```html" + CDN_GAME + "```"));
    extractArtifactMock.mockImplementation(() => ({ text: "Here's your game!", artifactHtml: CDN_GAME, wasFenced: false }));
  });

  it("XS.1 a CDN-loading build triggers ONE corrective retry, and the clean rebuild ships", async () => {
    replyMock.mockResolvedValue({ text: "Rebuilt properly!", artifactHtml: CLEAN_GAME, wasFenced: false });

    const res = await POST(makeReq({ message: "make a 3D game where Calvin walks around", history: [] }));
    const done = doneOf(await res.text());

    expect(replyMock).toHaveBeenCalledTimes(1); // exactly one corrective retry
    expect(done.artifactHtml).toContain("CLEAN GAME");
    expect(done.artifactHtml).not.toContain("cdnjs.cloudflare.com"); // the bypass never reaches a kid
    // The retry must NAME the offending URL and forbid the whole tag class.
    expect(replyMock.mock.calls[0]![0].message).toContain("cdnjs.cloudflare.com");
    expect(replyMock.mock.calls[0]![0].message).toMatch(/NO `?<script src/i);
  });

  it("XS.2 fails SOFT — if the retry is still a bypass, the original is served, not dropped", async () => {
    replyMock.mockResolvedValue({ text: "same again", artifactHtml: CDN_GAME, wasFenced: false });

    const res = await POST(makeReq({ message: "make a 3D game where Calvin walks around", history: [] }));
    const done = doneOf(await res.text());

    // Visible + repairable beats dropped — the existing import-lint contract.
    expect(done.artifactHtml).toContain("cdnjs.cloudflare.com");
  });

  // The relative form of the same bypass, found by running all 312 stored
  // conversations through the browser harness: a game that invented a local
  // multi-file three.js layout and died on "Failed to resolve module specifier".
  it("XS.4 a build importing files that don't exist gets the same corrective retry", async () => {
    const DANGLING =
      `<!doctype html><html><body><canvas id="c"></canvas>\n` +
      `<script type="module">import * as THREE from './three.module.js';\nimport './main.js';</script></body></html>`;
    replyStreamMock.mockReturnValue(one("Here!\n```html" + DANGLING + "```"));
    extractArtifactMock.mockImplementation(() => ({ text: "Here!", artifactHtml: DANGLING, wasFenced: false }));
    replyMock.mockResolvedValue({ text: "Rebuilt!", artifactHtml: CLEAN_GAME, wasFenced: false });

    const res = await POST(makeReq({ message: "make a 3D car racing game", history: [] }));
    const done = doneOf(await res.text());

    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(done.artifactHtml).toContain("CLEAN GAME");
    expect(done.artifactHtml).not.toContain("./three.module.js");
    expect(replyMock.mock.calls[0]![0].message).toContain("./three.module.js");
  });

  it("XS.3 a correct pipeline game ships untouched, with NO corrective retry (guard never misfires)", async () => {
    extractArtifactMock.mockImplementation(() => ({ text: "Here!", artifactHtml: CLEAN_GAME, wasFenced: false }));
    replyStreamMock.mockReturnValue(one("Here!\n```html" + CLEAN_GAME + "```"));

    const res = await POST(makeReq({ message: "make a 3D game", history: [] }));
    const done = doneOf(await res.text());

    expect(replyMock).not.toHaveBeenCalled();
    expect(done.artifactHtml).toContain("CLEAN GAME");
  });
});

// Completeness guard (BUG-FIX-LOG 2026-07-22): the model can end a build with
// finishReason STOP ("done") on a TRUNCATED game — it wrote the intro + CSS and
// quit mid-file (owner's "30 New Testament characters" prompt stopped ~5K chars
// three runs straight, then published blank). Nothing verified the HTML closed.
// The guard: a build whose document opened <html> but never reached </html> is
// never shipped — one corrective regen; if it still can't finish, a friendly
// retry, NEVER a blank artifact.
describe("POST /api/chat — never publish a truncated/blank build", () => {
  const TRUNCATED = "<!doctype html><html><head><style>body{margin:0}"; // opened <html>, NO </html>
  const WHOLE = "<!doctype html><html><head></head><body>WHOLE GAME</body></html>";

  beforeEach(() => {
    authMock.mockResolvedValue(null);
    replyStreamMock.mockReturnValue(one("Here's your game!\n```html" + TRUNCATED + "```"));
    extractArtifactMock.mockImplementation(() => ({ text: "Here's your game!", artifactHtml: TRUNCATED, wasFenced: false }));
  });

  const doneOf = (text: string) => JSON.parse(text.trim().split("\n").find((l) => l.includes('"done"'))!);

  it("CG.1 a truncated build is NOT shipped — one corrective retry produces a whole game", async () => {
    replyMock.mockResolvedValue({ text: "Here it is, complete!", artifactHtml: WHOLE, wasFenced: false });

    const res = await POST(makeReq({ message: "make a big game with 30 characters", history: [] }));
    const done = doneOf(await res.text());

    expect(replyMock).toHaveBeenCalledTimes(1); // exactly one corrective retry
    expect(done.artifactHtml).toContain("WHOLE GAME"); // the complete game shipped
    expect(done.artifactHtml).not.toContain("margin:0}"); // never the truncated one
  });

  it("CG.2 truncated build where BOTH the retry AND the starter build stay cut off → NO artifact, a friendly retry", async () => {
    // Every reply() (compact retry + reduced starter) comes back truncated.
    replyMock.mockResolvedValue({ text: "cut off again", artifactHtml: "<!doctype html><html><body>still cut", wasFenced: false });

    const res = await POST(makeReq({ message: "make a big game with 30 characters", history: [] }));
    const done = doneOf(await res.text());

    expect(done.artifactHtml == null).toBe(true); // nothing blank published
    expect(done.text).toBe(BUILD_INCOMPLETE_RETRY); // only after the split also fails
  });

  // Auto-split (owner ask 2026-07-23): when the compact retry still can't fit
  // the whole thing, don't dead-end — build a WORKING game with a small subset
  // and offer to add the rest. Turns "too big" into a playable game + a nudge.
  it("CG.5 retry still truncated → AUTO-SPLIT ships a working starter game and offers to add the rest", async () => {
    replyMock
      .mockResolvedValueOnce({ text: "still cut", artifactHtml: "<!doctype html><html><body>still cut", wasFenced: false }) // compact retry: truncated
      .mockResolvedValueOnce({ text: "A starter!", artifactHtml: WHOLE, wasFenced: false }); // reduced starter: finishes

    const res = await POST(makeReq({ message: "a Bible game with all 100 New Testament names", history: [] }));
    const done = doneOf(await res.text());

    expect(replyMock).toHaveBeenCalledTimes(2); // compact retry, then the starter build
    expect(done.artifactHtml).toContain("WHOLE GAME"); // a real, playable game shipped
    expect(done.text).toContain(BUILD_STARTER_SPLIT); // leads with the "add the rest" offer
    expect(done.text).not.toBe(BUILD_INCOMPLETE_RETRY); // never the dead-end message
    // The starter's second reply asked for a SMALL subset that finishes.
    expect(replyMock.mock.calls[1]![0].message).toMatch(/small representative subset|6 to 10 items/i);
  });

  it("CG.3 a COMPLETE build ships as-is, with NO corrective retry (guard never misfires)", async () => {
    extractArtifactMock.mockImplementation(() => ({ text: "Here!", artifactHtml: WHOLE, wasFenced: false }));

    const res = await POST(makeReq({ message: "make me a game", history: [] }));
    const done = doneOf(await res.text());

    expect(replyMock).not.toHaveBeenCalled(); // no completeness retry needed
    expect(done.artifactHtml).toContain("WHOLE GAME");
  });

  it("CG.4 a failed edit patch NEVER regenerates — the game stays untouched and the child gets a soft retry (owner decision 2026-08-10)", async () => {
    // History with an existing game → routes to the EDIT path, not fresh build.
    // The patch can't apply and the strict rung can't rescue it. The OLD
    // fallback was a full regeneration — which is what replaced the owner's
    // 89-message AutoRicksaw city ("the whole game changed and it is
    // pathetic"). The contract now: the rebuild path must never even be
    // CALLED from a failed edit; the child keeps their game and is told
    // honestly what to do next.
    const history = [
      { id: "1", role: "child", text: "make a game", createdAt: 1 },
      { id: "2", role: "assistant", text: "Here!", artifactHtml: WHOLE, createdAt: 2 },
    ];
    extractArtifactMock.mockImplementation(() => ({ text: "edit", artifactHtml: TRUNCATED, wasFenced: false }));
    replyMock.mockResolvedValue({ text: "still cut", artifactHtml: TRUNCATED, wasFenced: false });

    const res = await POST(makeReq({ message: "add 30 characters", history }));
    const done = doneOf(await res.text());

    expect(replyMock).not.toHaveBeenCalled(); // the regeneration path is DEAD for edits
    expect(done.artifactHtml == null).toBe(true); // nothing replaces the child's game
    expect(done.text).toBe(EDIT_FAILED_SOFT); // honest, with a way forward
  });
});

describe("POST /api/chat — unfenced/malformed game code doesn't corrupt the chat bubble (BUG-FIX-LOG 2026-07-14)", () => {
  const PROSE = "Here's your updated game!";
  const ARTIFACT = "<!doctype html><html><body>UPDATED GAME</body></html>";

  it("F.1 unfenced reply (wasFenced: false) is re-fenced before it reaches the chat bubble", async () => {
    authMock.mockResolvedValue(null);
    const rawUnfenced = `${PROSE}\n${ARTIFACT}`; // what the model actually streamed — no fence at all
    replyStreamMock.mockReturnValue(one(rawUnfenced));
    extractArtifactMock.mockImplementation(() => ({ text: PROSE, artifactHtml: ARTIFACT, wasFenced: false }));

    const res = await POST(makeReq({ message: "make it faster", history: [] }));
    const text = await res.text();
    const done = JSON.parse(text.trim().split("\n").find((l) => l.includes('"done"'))!);

    expect(done.text).not.toBe(rawUnfenced); // the raw text must never reach the client verbatim
    expect(done.text).toContain("```html");
    expect(done.text).toMatch(/```html\n<!doctype html>.*UPDATED GAME.*```/s);
  });

  it("F.2 a cleanly fenced reply (wasFenced: true) is sent unchanged, including trailing prose", async () => {
    authMock.mockResolvedValue(null);
    const cleanReply = `Here you go!\n\`\`\`html\n${ARTIFACT}\n\`\`\`\nEnjoy!`;
    replyStreamMock.mockReturnValue(one(cleanReply));
    extractArtifactMock.mockImplementation(() => ({
      text: "Here you go!\n\nEnjoy!",
      artifactHtml: ARTIFACT,
      wasFenced: true,
    }));

    const res = await POST(makeReq({ message: "make me a game", history: [] }));
    const text = await res.text();
    const done = JSON.parse(text.trim().split("\n").find((l) => l.includes('"done"'))!);

    // Untouched byte-for-byte — including "Enjoy!" landing AFTER the code block.
    expect(done.text).toBe(cleanReply);
  });

  it("F.3 the re-fenced display text parses as ONE clean html code block (repro of the production corruption)", async () => {
    authMock.mockResolvedValue(null);
    // Representative reduction of the reported production bug: indented,
    // blank-line-separated CSS is exactly what makes CommonMark chop RAW
    // (unfenced) text into multiple stray "indented code block" nodes, each
    // rendering its own spurious "code / Download / Copy" widget.
    const indentedCss = [
      "<style>",
      "    #score-container {",
      "        position: fixed; top: 10px;",
      "    }",
      "",
      "    .dist-tag {",
      "        color: white;",
      "    }",
      "</style>",
    ].join("\n");
    const artifact = `<!doctype html><html><head>${indentedCss}</head><body>game</body></html>`;
    const rawUnfenced = `Here's the update!\n${artifact}`;
    replyStreamMock.mockReturnValue(one(rawUnfenced));
    extractArtifactMock.mockImplementation(() => ({
      text: "Here's the update!",
      artifactHtml: artifact,
      wasFenced: false,
    }));

    const res = await POST(makeReq({ message: "make it faster", history: [] }));
    const text = await res.text();
    const done = JSON.parse(text.trim().split("\n").find((l) => l.includes('"done"'))!);

    // Before the fix: parsing the raw unfenced text directly (what used to be
    // sent to the client) produces stray code nodes with no language — the
    // historical bug shape.
    const brokenNodes = await codeNodes(rawUnfenced);
    expect(brokenNodes.some((n) => n.lang === null)).toBe(true);

    // After the fix: `done.text` parses as exactly ONE code node, fenced as html.
    const fixedNodes = await codeNodes(done.text);
    expect(fixedNodes).toHaveLength(1);
    expect(fixedNodes[0]!.lang).toBe("html");
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

describe("POST /api/chat — mid-answer model restart (2026-07-13)", () => {
  it("R.1 a restart chunk relays as a restart event and resets the accumulator — done carries only the final model's answer", async () => {
    authMock.mockResolvedValue(null);
    async function* restarting() {
      yield { kind: "delta", text: "<html>partial" };
      yield { kind: "restart", text: "" };
      yield { kind: "delta", text: "Fresh game" };
    }
    replyStreamMock.mockReturnValue(restarting());

    const res = await POST(makeReq({ message: "make me a game", history: [] }));
    const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));

    expect(lines.some((e) => e.type === "restart")).toBe(true);
    const done = lines.find((e) => e.type === "done");
    expect(done.text).toBe("Fresh game"); // the wiped partial never reaches done/usage
  });
});

describe("POST /api/chat — resumable turns (2026-07-13)", () => {
  it("RT.1 persists start + the finished result under the client's replyId", async () => {
    turnCalls.length = 0;
    authMock.mockResolvedValue({ userId: "user:kid@x.com" });
    replyStreamMock.mockReturnValue(one("Done game"));

    const res = await POST(makeReq({ message: "make me a game", history: [], replyId: "reply-1" }));
    await res.text(); // drain the stream so the producer finishes

    expect(turnCalls[0]).toMatchObject({ op: "start", replyId: "reply-1", userId: "user:kid@x.com" });
    expect(turnCalls.at(-1)).toMatchObject({ op: "complete", replyId: "reply-1", text: "Done game" });
  });

  it("RT.2 a stream error marks the turn failed (client falls back to re-generating)", async () => {
    turnCalls.length = 0;
    authMock.mockResolvedValue({ userId: "user:kid@x.com" });
    // eslint-disable-next-line require-yield
    replyStreamMock.mockReturnValue((async function* (): AsyncGenerator<never> { throw new Error("boom"); })());

    const res = await POST(makeReq({ message: "hello", history: [], replyId: "reply-2" }));
    await res.text();

    expect(turnCalls.map((c) => c.op)).toEqual(["start", "fail"]);
  });

  it("RT.3 without a replyId there is no turn bookkeeping (old clients unaffected)", async () => {
    turnCalls.length = 0;
    authMock.mockResolvedValue(null);
    replyStreamMock.mockReturnValue(one("Hello!"));

    const res = await POST(makeReq({ message: "hello", history: [] }));
    await res.text();

    expect(turnCalls).toEqual([]);
  });
});

describe("POST /api/chat — screen-time tracking (PRD-SCREEN-TIME-CAP-MVP Part B)", () => {
  beforeEach(() => {
    screenTimePings.length = 0;
    screenTimeCalls.length = 0;
    screenTimeThrows = false;
  });

  it("SC.1 a signed-in completion records a ping AND triggers screen-time recompute", async () => {
    authMock.mockResolvedValue({ userId: "user:kid@x.com", name: "Kid" });
    replyStreamMock.mockReturnValue(one("Hello!"));

    const res = await POST(makeReq({ message: "hello", history: [] }));
    await res.text();

    expect(res.status).toBe(200);
    expect(screenTimePings).toEqual(["user:kid@x.com"]);
    expect(screenTimeCalls).toEqual([{ accountId: "user:kid@x.com", userLabel: "Kid" }]);
  });

  it("SC.2 a guest completion never pings or recomputes screen time", async () => {
    authMock.mockResolvedValue(null);
    replyStreamMock.mockReturnValue(one("Hello!"));

    const res = await POST(makeReq({ message: "hello", history: [] }));
    await res.text();

    expect(screenTimePings).toEqual([]);
    expect(screenTimeCalls).toEqual([]);
  });

  it("SC.3 a thrown error from the screen-time store doesn't fail the chat response (fail-open)", async () => {
    screenTimeThrows = true;
    authMock.mockResolvedValue({ userId: "user:kid@x.com", name: "Kid" });
    replyStreamMock.mockReturnValue(one("Hello!"));

    const res = await POST(makeReq({ message: "hello", history: [] }));
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).toContain('"type":"done"');
  });
});

describe("POST /api/chat — cost metering (2026-07-13)", () => {
  it("M.1 usage records the FULL reply including the game code block — never the stripped text", async () => {
    usageRows.length = 0;
    authMock.mockResolvedValue({ userId: "user:kid@x.com" });
    const gameReply = "Here's your game!\n```html\n<html>" + "x".repeat(4000) + "</html>\n```";
    replyStreamMock.mockReturnValue(one(gameReply));
    // extractArtifact strips the code block for display purposes:
    extractArtifactMock.mockImplementation(() => ({ text: "Here's your game!", artifactHtml: "<html>…</html>" }));

    const res = await POST(makeReq({ message: "make me a game", history: [] }));
    await res.text();

    expect(usageRows).toHaveLength(1);
    expect(usageRows[0]!.outputText).toBe(gameReply); // full billed output, not the ~4-token stripped text
  });
});

// Patch-based feature edits (BUG-FIX-LOG class fix, 2026-07-18): a follow-up
// request on an already-good game used to regenerate the whole file and
// regress unrelated parts. isGameEditTurn/currentGameHtml/editReplyProse
// (game-edit.ts) and applyPatch (repair-prompt.ts) are the REAL
// implementations here, not mocked — this is the actual regression test
// proving the mechanism preserves everything untouched.
describe("POST /api/chat — patch-based feature edits", () => {
  const CURRENT_GAME = '<!doctype html><html><body><div id="score">0</div><div>OLD_FEATURE</div></body></html>';
  const historyWithGame = [
    { id: "1", role: "child" as const, text: "make me a game", createdAt: 1 },
    {
      id: "2", role: "assistant" as const,
      text: "Here!\n```html\n" + CURRENT_GAME + "\n```",
      artifactHtml: CURRENT_GAME,
      createdAt: 2,
    },
  ];

  beforeEach(() => {
    authMock.mockResolvedValue(null);
  });

  it("a clean SEARCH/REPLACE reply patches ONLY the matched hunk — everything else survives byte-for-byte", async () => {
    const patchReply = "Added a medic kit! 🎮\n<<<<<<< SEARCH\nOLD_FEATURE\n=======\nMEDIC_KIT_FEATURE\n>>>>>>> REPLACE";
    replyStreamMock.mockReturnValue(one(patchReply));

    const res = await POST(makeReq({ message: "add a medic kit", history: historyWithGame }));
    const text = await res.text();
    const done = JSON.parse(text.trim().split("\n").find((l) => l.includes('"done"'))!);

    expect(done.artifactHtml).toBe(CURRENT_GAME.replace("OLD_FEATURE", "MEDIC_KIT_FEATURE"));
    expect(done.text).toBe("Added a medic kit! 🎮"); // the sentence only — never the raw hunks
    expect(replyMock).not.toHaveBeenCalled(); // no fallback needed, patch applied clean
  });

  // "Continue from here" (chat-rewind.ts): the client can name an EARLIER
  // game message as the one to build on. This proves the wiring end to end —
  // the later (regressed) game stays in `history` (nothing deleted from the
  // chat), but the patch targets the pinned, earlier one.
  it("activeGameMessageId pins the patch target to an EARLIER game even with a newer one in history", async () => {
    const OLD_GOOD_GAME = '<!doctype html><html><body><div id="score">0</div><div>GOOD_FEATURE</div></body></html>';
    const NEW_REGRESSED_GAME = "<!doctype html><html><body>BROKEN</body></html>";
    const historyWithBothVersions = [
      { id: "1", role: "child" as const, text: "make me a game", createdAt: 1 },
      {
        id: "2", role: "assistant" as const,
        text: "Here!\n```html\n" + OLD_GOOD_GAME + "\n```",
        artifactHtml: OLD_GOOD_GAME,
        createdAt: 2,
      },
      { id: "3", role: "child" as const, text: "add sound", createdAt: 3 },
      {
        id: "4", role: "assistant" as const,
        text: "Added!\n```html\n" + NEW_REGRESSED_GAME + "\n```",
        artifactHtml: NEW_REGRESSED_GAME,
        createdAt: 4,
      },
    ];
    const patchReply = "Added a medic kit! 🎮\n<<<<<<< SEARCH\nGOOD_FEATURE\n=======\nMEDIC_KIT_FEATURE\n>>>>>>> REPLACE";
    replyStreamMock.mockReturnValue(one(patchReply));

    const res = await POST(makeReq({
      message: "add a medic kit",
      history: historyWithBothVersions,
      activeGameMessageId: "2",
    }));
    const text = await res.text();
    const done = JSON.parse(text.trim().split("\n").find((l) => l.includes('"done"'))!);

    expect(done.artifactHtml).toBe(OLD_GOOD_GAME.replace("GOOD_FEATURE", "MEDIC_KIT_FEATURE"));
    expect(replyMock).not.toHaveBeenCalled(); // patched clean against the pinned version — no fallback
  });

  it("an off-topic reply (no patch, no full doc) passes through as ordinary chat — the game is untouched and no extra Gemini call is wasted", async () => {
    replyStreamMock.mockReturnValue(one("Pandas eat bamboo! 🐼"));

    const res = await POST(makeReq({ message: "what do pandas eat?", history: historyWithGame }));
    const text = await res.text();
    const done = JSON.parse(text.trim().split("\n").find((l) => l.includes('"done"'))!);

    expect(done.text).toBe("Pandas eat bamboo! 🐼");
    expect(done.artifactHtml).toBeFalsy(); // game untouched — no new artifact sent
    expect(replyMock).not.toHaveBeenCalled(); // key: no wasted full-regeneration call
  });

  // BUG-FIX-LOG 2026-07-18 follow-up ("multiple blocks and not working
  // code"): a truncated/garbled patch attempt has NO complete SEARCH/REPLACE
  // block for applyPatch() to find, so it fell into the SAME branch as
  // genuine off-topic chat and got shown to the child as literal raw text
  // (visible <<<<<<< markers, broken fragments). looksLikeAttemptedEdit
  // must catch this and route it to the fallback regeneration instead.
  it("a truncated/malformed patch attempt is NEVER shown raw — soft-fails with the game untouched (owner decision 2026-08-10)", async () => {
    const truncatedReply = "Sure, adding that now!\n<<<<<<< SEARCH\nOLD_FEATURE\n";
    replyStreamMock.mockReturnValue(one(truncatedReply));

    const res = await POST(makeReq({ message: "add a medic kit", history: historyWithGame }));
    const text = await res.text();
    const done = JSON.parse(text.trim().split("\n").find((l) => l.includes('"done"'))!);

    expect(done.text).not.toContain("<<<<<<<"); // never leak raw patch markers to the chat bubble
    expect(replyMock).not.toHaveBeenCalled(); // regeneration is DEAD for failed edits
    expect(done.artifactHtml).toBeNull(); // the child's game is untouched
    expect(done.text).toBe(EDIT_FAILED_SOFT);
  });

  // Same class: applyPatch()'s "regeneration" fallback trusts ANY ```html
  // fence as a full replacement — if the model ignored the patch contract
  // and explained "here's the changed part" with a PARTIAL snippet, that
  // fragment would silently become the entire game.
  it("a partial snippet mistaken for a full document is rejected — soft-fail, never corrupts the game (owner decision 2026-08-10)", async () => {
    const partialSnippetReply = "Here's the updated part:\n```html\n<div>MEDIC_KIT_FEATURE</div>\n```";
    replyStreamMock.mockReturnValue(one(partialSnippetReply));

    const res = await POST(makeReq({ message: "add a medic kit", history: historyWithGame }));
    const text = await res.text();
    const done = JSON.parse(text.trim().split("\n").find((l) => l.includes('"done"'))!);

    expect(replyMock).not.toHaveBeenCalled();
    expect(done.artifactHtml).toBeNull(); // never the bare <div> snippet, never a rebuild
    expect(done.text).toBe(EDIT_FAILED_SOFT);
  });

  it("a genuinely attempted-but-mismatched patch soft-fails — not a dead end, not a rebuild (owner decision 2026-08-10)", async () => {
    const badPatchReply = "Trying to add that!\n<<<<<<< SEARCH\nTHIS_TEXT_IS_NOT_IN_THE_SOURCE\n=======\nNEW\n>>>>>>> REPLACE";
    replyStreamMock.mockReturnValue(one(badPatchReply));

    const res = await POST(makeReq({ message: "add a medic kit", history: historyWithGame }));
    const text = await res.text();
    const done = JSON.parse(text.trim().split("\n").find((l) => l.includes('"done"'))!);

    expect(replyMock).not.toHaveBeenCalled();
    expect(done.artifactHtml).toBeNull();
    expect(done.text).toBe(EDIT_FAILED_SOFT); // honest, with a way forward — not silence
  });

  // #2a history: BUG-FIX-LOG 2026-07-23 ("racing game" incident) made a 3D
  // request on a 2D game REBUILD instead of patch (patching fakes depth on the
  // 2D canvas). SUPERSEDED by the owner decision 2026-07-26: a 2D→3D
  // conversion is now a whole NEW game — the route answers with the two-games
  // info panel and never touches the model on that turn. The rebuild itself
  // still happens, but in the fresh chat via forceRebuild (see the dedicated
  // "2D→3D conversion is a NEW game" describe block).
  it("C.R a 3D request on a 2D game never patches AND never rebuilds in place — it becomes the new-game panel", async () => {
    const res = await POST(makeReq({ message: "make it 3D", history: historyWithGame }));
    const done = JSON.parse((await res.text()).trim().split("\n").find((l) => l.includes('"done"'))!);

    expect(strictEditRetryMock).not.toHaveBeenCalled(); // no cheap edit rung
    expect(replyMock).not.toHaveBeenCalled(); // no regen fallback
    expect(replyStreamMock).not.toHaveBeenCalled(); // no in-place rebuild either
    expect(done.threeDNewGame).toBe(true);
    expect(done.artifactHtml).toBeNull(); // the 2D game is untouched
  });

  // BUG-FIX-LOG 2026-07-23 (owner UAT "remove the leaderboard" corrupted the NT
  // quiz): the model fenced a HALF-PATCHED document with raw SEARCH/REPLACE
  // markers left inside. Before the applyPatch conflict-marker guard, that shipped
  // verbatim — markers rendered in <style>, the edit never took. Now it's a failed
  // patch → full regeneration, and a game with markers is NEVER published.
  it("a fenced document that leaked SEARCH/REPLACE markers is rejected — full regeneration, never a corrupted game", async () => {
    const leaked =
      "Removed it!\n```html\n<!doctype html><html><head><style>#x{color:red}\n\n" +
      ">>>>>>> REPLACE\n<<<<<<< SEARCH\n<div>Leaderboard</div>\n=======\n</style></head><body>game</body></html>\n```";
    replyStreamMock.mockReturnValue(one(leaked));

    const res = await POST(makeReq({ message: "remove the leaderboard", history: historyWithGame }));
    const done = JSON.parse((await res.text()).trim().split("\n").find((l) => l.includes('"done"'))!);

    // A marker-corrupted document is NEVER published — and (owner decision
    // 2026-08-10) never triggers a rebuild either: the game stays untouched.
    expect(done.artifactHtml).toBeNull();
    expect(replyMock).not.toHaveBeenCalled();
    expect(done.text).toBe(EDIT_FAILED_SOFT);
  });

  // ---- Penguin-maze hardening (2026-07-18): strict retry, kill switch, honest messaging ----

  const COMPLETE_REWRITE = '<!doctype html><html><body><div id="score">0</div><div>REWRITTEN_GAME</div></body></html>';

  it("a full-rewrite reply on an edit turn triggers ONE hunks-only retry — a clean retry patch wins and the rewrite is discarded", async () => {
    replyStreamMock.mockReturnValue(one("I made it 3D!\n```html\n" + COMPLETE_REWRITE + "\n```"));
    strictEditRetryMock.mockResolvedValue({
      text: "Added the 3D look! 🎮\n<<<<<<< SEARCH\nOLD_FEATURE\n=======\nTHREE_D_FEATURE\n>>>>>>> REPLACE",
    });

    const res = await POST(makeReq({ message: "make the car faster", history: historyWithGame }));
    const text = await res.text();
    const done = JSON.parse(text.trim().split("\n").find((l) => l.includes('"done"'))!);

    expect(strictEditRetryMock).toHaveBeenCalledTimes(1);
    expect(done.artifactHtml).toBe(CURRENT_GAME.replace("OLD_FEATURE", "THREE_D_FEATURE")); // patched, NOT the rewrite
    expect(done.text).toBe("Added the 3D look! 🎮");
    expect(replyMock).not.toHaveBeenCalled();
  });

  it("when the retry answers NEEDS_FULL_REBUILD the original rewrite is accepted — with the model's own prose, never raw code", async () => {
    replyStreamMock.mockReturnValue(one("I made it 3D!\n```html\n" + COMPLETE_REWRITE + "\n```"));
    strictEditRetryMock.mockResolvedValue({ text: "NEEDS_FULL_REBUILD" });

    const res = await POST(makeReq({ message: "make the car faster", history: historyWithGame }));
    const text = await res.text();
    const done = JSON.parse(text.trim().split("\n").find((l) => l.includes('"done"'))!);

    expect(done.artifactHtml).toBe(COMPLETE_REWRITE);
    expect(done.text).toContain("I made it 3D!");
    expect(done.text).not.toMatch(/```|<html/i);
  });

  it("a code-only rewrite accepted after a failed retry gets the HONEST rebuilt-game line, not a bare success claim", async () => {
    replyStreamMock.mockReturnValue(one("```html\n" + COMPLETE_REWRITE + "\n```"));
    strictEditRetryMock.mockRejectedValue(new Error("model unavailable"));

    const res = await POST(makeReq({ message: "make the car faster", history: historyWithGame }));
    const text = await res.text();
    const done = JSON.parse(text.trim().split("\n").find((l) => l.includes('"done"'))!);

    expect(done.artifactHtml).toBe(COMPLETE_REWRITE); // retry failure never dead-ends the turn
    expect(done.text).toBe(REBUILT_GAME_LINE); // honest: a rebuild happened, invite bug reports
  });

  it("a failed patch soft-fails with the EDIT_FAILED_SOFT line — never a silent rebuild story (owner decision 2026-08-10)", async () => {
    // Supersedes the REBUILT_GAME_LINE honesty rule: with regeneration gone,
    // the honest message is that nothing changed — and what to try next.
    const badPatchReply = "Trying!\n<<<<<<< SEARCH\nNOT_IN_SOURCE\n=======\nNEW\n>>>>>>> REPLACE";
    replyStreamMock.mockReturnValue(one(badPatchReply));

    const res = await POST(makeReq({ message: "add a medic kit", history: historyWithGame }));
    const text = await res.text();
    const done = JSON.parse(text.trim().split("\n").find((l) => l.includes('"done"'))!);

    expect(done.artifactHtml).toBeNull();
    expect(done.text).toBe(EDIT_FAILED_SOFT);
  });

  // Kill switch (the user's guaranteed rollback): GAME_EDIT_PATCH=off restores
  // exact pre-patch routing — the edit branch, retry, and fallback all vanish.
  it("GAME_EDIT_PATCH=off restores pre-patch behavior: the stream's full rewrite is delivered as-is, no patch machinery runs", async () => {
    process.env.GAME_EDIT_PATCH = "off";
    try {
      const rewriteReply = "New game!\n```html\n" + COMPLETE_REWRITE + "\n```";
      replyStreamMock.mockReturnValue(one(rewriteReply));
      extractArtifactMock.mockImplementation(() => ({ text: "New game!", artifactHtml: COMPLETE_REWRITE }));

      const res = await POST(makeReq({ message: "add a medic kit", history: historyWithGame }));
      const text = await res.text();
      const done = JSON.parse(text.trim().split("\n").find((l) => l.includes('"done"'))!);

      expect(done.artifactHtml).toBe(COMPLETE_REWRITE);
      expect(replyMock).not.toHaveBeenCalled();
      expect(strictEditRetryMock).not.toHaveBeenCalled();
    } finally {
      delete process.env.GAME_EDIT_PATCH;
    }
  });

  it("a fresh build with no game yet never touches the patch/fallback path", async () => {
    extractArtifactMock.mockImplementation(() => ({ text: "Here's your game!", artifactHtml: "<html>NEW GAME</html>" }));
    replyStreamMock.mockReturnValue(one("```html<html>NEW GAME</html>```"));

    const res = await POST(makeReq({ message: "make me a racing game", history: [] }));
    const text = await res.text();
    const done = JSON.parse(text.trim().split("\n").find((l) => l.includes('"done"'))!);

    expect(done.artifactHtml).toBe("<html>NEW GAME</html>");
    expect(replyMock).not.toHaveBeenCalled();
  });
});

// Deterministic three-import lint (BUG-FIX-LOG 2026-07-20 "DoubleSide"): a
// game importing a name the vendored bundle doesn't export dies on its
// import line. The route must catch this server-side — a patch that
// introduces one is a FAILED patch, and a fresh build gets ONE corrective
// retry — so a dead-on-arrival game never reaches the kid.
describe("POST /api/chat — three-import lint", () => {
  const BAD_IMPORT_GAME =
    '<!doctype html><html><body><script type="module">import { Scene, TubeGeometry } from "three";</script></body></html>';
  const CLEAN_GAME =
    '<!doctype html><html><body><script type="module">import { Scene } from "three";</script></body></html>';

  beforeEach(() => {
    authMock.mockResolvedValue(null);
  });

  it("L.1 a fresh build with an unknown three import gets ONE corrective retry, and the clean retry is served", async () => {
    replyStreamMock.mockReturnValue(one("Here!\n```html\n" + BAD_IMPORT_GAME + "\n```"));
    extractArtifactMock.mockImplementation((t: string) => ({
      text: "Here!",
      artifactHtml: t.includes("TubeGeometry") ? BAD_IMPORT_GAME : undefined,
      wasFenced: true,
    }));
    replyMock.mockResolvedValue({ text: "Fixed!", artifactHtml: CLEAN_GAME, wasFenced: true });

    const res = await POST(makeReq({ message: "make me a 3d game", history: [] }));
    const text = await res.text();
    const done = JSON.parse(text.trim().split("\n").find((l) => l.includes('"done"'))!);

    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(replyMock.mock.calls[0]![0].message).toContain("TubeGeometry"); // told exactly what crashed
    expect(replyMock.mock.calls[0]![0]).toMatchObject({ forceFullRegen: true });
    expect(done.artifactHtml).toBe(ensureAssetRuntime(CLEAN_GAME)); // clean retry, import map floored in
  });

  it("L.2 if the corrective retry fails, the original is still served — floor stays 'no worse', never a dead end", async () => {
    replyStreamMock.mockReturnValue(one("Here!\n```html\n" + BAD_IMPORT_GAME + "\n```"));
    extractArtifactMock.mockImplementation(() => ({ text: "Here!", artifactHtml: BAD_IMPORT_GAME, wasFenced: true }));
    replyMock.mockRejectedValue(new Error("overloaded"));

    const res = await POST(makeReq({ message: "make me a 3d game", history: [] }));
    const text = await res.text();
    const done = JSON.parse(text.trim().split("\n").find((l) => l.includes('"done"'))!);

    // Served, visible, repairable — not dropped. The import map is floored in, so
    // the specifier resolves; the unknown NAMED export (TubeGeometry) is the
    // remaining issue the kid can repair — the floor is 'no worse', never a dead end.
    expect(done.artifactHtml).toBe(ensureAssetRuntime(BAD_IMPORT_GAME));
  });

  it("L.3 a clean fresh build costs NO extra Gemini call", async () => {
    replyStreamMock.mockReturnValue(one("Here!\n```html\n" + CLEAN_GAME + "\n```"));
    extractArtifactMock.mockImplementation(() => ({ text: "Here!", artifactHtml: CLEAN_GAME, wasFenced: true }));

    const res = await POST(makeReq({ message: "make me a 3d game", history: [] }));
    await res.text();

    expect(replyMock).not.toHaveBeenCalled();
  });

  it("L.4 an edit patch that INTRODUCES an unknown three import is a failed patch — soft-fail, never ships the crash (owner decision 2026-08-10)", async () => {
    const GAME = '<!doctype html><html><body><div>OLD_FEATURE</div></body></html>';
    const history = [
      { id: "1", role: "child" as const, text: "make me a game", createdAt: 1 },
      { id: "2", role: "assistant" as const, text: "Here!\n```html\n" + GAME + "\n```", artifactHtml: GAME, createdAt: 2 },
    ];
    const patchReply =
      "Added a track! 🎮\n<<<<<<< SEARCH\n<div>OLD_FEATURE</div>\n=======\n" +
      '<script type="module">import { TubeGeometry } from "three";</script>\n>>>>>>> REPLACE';
    replyStreamMock.mockReturnValue(one(patchReply));

    const res = await POST(makeReq({ message: "add a tube track", history }));
    const text = await res.text();
    const done = JSON.parse(text.trim().split("\n").find((l) => l.includes('"done"'))!);

    expect(replyMock).not.toHaveBeenCalled();
    expect(done.artifactHtml).toBeNull(); // never the import-crashing patch result, never a rebuild
    expect(done.text).toBe(EDIT_FAILED_SOFT);
  });
});

describe("POST /api/chat — new-game consent prompt (PRD-RESILIENT-GENERATION §11)", () => {
  const CURRENT_GAME = '<!doctype html><html><body><div id="score">0</div><div>RACING</div></body></html>';
  const historyWithGame = [
    { id: "1", role: "child" as const, text: "make me a racing game", createdAt: 1 },
    {
      id: "2", role: "assistant" as const,
      text: "Here!\n```html\n" + CURRENT_GAME + "\n```",
      artifactHtml: CURRENT_GAME,
      createdAt: 2,
    },
  ];

  beforeEach(() => {
    authMock.mockResolvedValue(null);
  });

  const done = (text: string) => JSON.parse(text.trim().split("\n").find((l) => l.includes('"done"'))!);

  it("N.1 a self-declared new game asks instead of rebuilding — nothing is touched", async () => {
    replyStreamMock.mockReturnValue(one("NEW_GAME_REQUEST"));

    const res = await POST(makeReq({ message: "now make a football game", history: historyWithGame }));
    const d = done(await res.text());

    expect(d.newGamePrompt).toBe(true);
    expect(d.text).toContain("whole new game"); // the friendly consent line
    expect(d.artifactHtml).toBeNull(); // nothing rebuilt — current game untouched
    expect(replyMock).not.toHaveBeenCalled(); // no destructive regeneration
    expect(strictEditRetryMock).not.toHaveBeenCalled();
  });

  it("N.2 forceRebuild ('Change this one') skips detection and builds the new game in place", async () => {
    const NEW_GAME = "<!doctype html><html><body>FOOTBALL</body></html>";
    extractArtifactMock.mockImplementation(() => ({ text: "Here's your game! 🎮", artifactHtml: NEW_GAME }));
    replyStreamMock.mockReturnValue(one("Here!\n```html\n" + NEW_GAME + "\n```"));

    const res = await POST(makeReq({ message: "now make a football game", history: historyWithGame, forceRebuild: true }));
    const d = done(await res.text());

    expect(d.newGamePrompt).toBeUndefined(); // never asked again
    expect(d.artifactHtml).toBe(NEW_GAME); // the new game delivered in place
    // the stream request carried forceRebuild through to the model
    expect(replyStreamMock.mock.calls[0]![0]).toMatchObject({ forceRebuild: true });
  });

  it("N.3 a reply that ALSO patches is treated as an edit, never a new-game prompt (fail toward not asking)", async () => {
    // A stray sentinel next to a real SEARCH/REPLACE must not hijack the edit.
    const patchReply = "Sure!\nNEW_GAME_REQUEST\n<<<<<<< SEARCH\nRACING\n=======\nRACING_FAST\n>>>>>>> REPLACE";
    replyStreamMock.mockReturnValue(one(patchReply));

    const res = await POST(makeReq({ message: "make it faster", history: historyWithGame }));
    const d = done(await res.text());

    expect(d.newGamePrompt).toBeUndefined();
    expect(d.artifactHtml).toBe(CURRENT_GAME.replace("RACING", "RACING_FAST")); // the patch applied
  });
});

describe("POST /api/chat — 2D→3D conversion is a NEW game (owner decision 2026-07-26)", () => {
  const TWO_D_GAME = '<!doctype html><html><body><div id="score">0</div><canvas></canvas></body></html>';
  const THREE_D_GAME =
    '<!doctype html><html><body><script type="module">import { Scene } from "three";</script></body></html>';
  const with2dGame = [
    { id: "1", role: "child" as const, text: "make me a racing game", createdAt: 1 },
    {
      id: "2", role: "assistant" as const,
      text: "Here!\n```html\n" + TWO_D_GAME + "\n```",
      artifactHtml: TWO_D_GAME,
      createdAt: 2,
    },
  ];

  beforeEach(() => {
    authMock.mockResolvedValue(null);
    usageRows.length = 0;
  });

  const done = (text: string) => JSON.parse(text.trim().split("\n").find((l) => l.includes('"done"'))!);

  it("D3.1 'make it 3d' on a 2D game answers with the two-games info panel instantly — no model call, nothing billed", async () => {
    const res = await POST(makeReq({ message: "make it 3d", history: with2dGame }));
    const d = done(await res.text());

    expect(d.threeDNewGame).toBe(true);
    expect(d.text).toContain("TWO games"); // the child learns they now have two games
    expect(d.artifactHtml).toBeNull(); // the 2D game is untouched
    expect(replyStreamMock).not.toHaveBeenCalled(); // zero model calls…
    expect(replyMock).not.toHaveBeenCalled();
    expect(usageRows).toHaveLength(0); // …and zero billing
  });

  it("D3.2 the OK path (forceRebuild, fired in the seeded fresh chat) streams the full 3D rebuild — the panel never re-asks", async () => {
    extractArtifactMock.mockImplementation(() => ({ text: FRESH_GAME_LINE, artifactHtml: THREE_D_GAME }));
    replyStreamMock.mockReturnValue(one("Here!\n```html\n" + THREE_D_GAME + "\n```"));

    const res = await POST(makeReq({ message: "make it 3d", history: with2dGame, forceRebuild: true }));
    const d = done(await res.text());

    expect(d.threeDNewGame).toBeUndefined();
    expect(replyStreamMock.mock.calls[0]![0]).toMatchObject({ forceRebuild: true });
    expect(d.artifactHtml).toBe(ensureAssetRuntime(THREE_D_GAME));
  });

  it("D3.3 a game already using Three.js edits normally — the panel only ever fires on a genuinely 2D game", async () => {
    const threeHistory = [
      { id: "1", role: "child" as const, text: "make me a 3d racing game", createdAt: 1 },
      {
        id: "2", role: "assistant" as const,
        text: "Here!\n```html\n" + THREE_D_GAME + "\n```",
        artifactHtml: THREE_D_GAME,
        createdAt: 2,
      },
    ];
    const patchReply =
      'Faster! 🎮\n<<<<<<< SEARCH\nimport { Scene } from "three";\n=======\nimport { Scene } from "three"; // fast\n>>>>>>> REPLACE';
    replyStreamMock.mockReturnValue(one(patchReply));

    const res = await POST(makeReq({ message: "make it more 3d and faster", history: threeHistory }));
    const d = done(await res.text());

    expect(d.threeDNewGame).toBeUndefined();
    expect(replyStreamMock).toHaveBeenCalledTimes(1); // an ordinary edit turn
  });
});

describe("POST /api/chat — model output safety block (finishReason SAFETY, KNOWN_BUGS #4)", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(null);
  });

  it("a SAFETY-blocked stream sends a kind redirect (blocked), never a scary error", async () => {
    replyStreamMock.mockReturnValue((async function* (): AsyncGenerator<never> {
      throw new SafetyBlockedError("gemini-3-flash-preview");
    })());

    const res = await POST(makeReq({ message: "make me a game", history: [] }));
    const text = await res.text();
    const events = text.trim().split("\n").map((l) => JSON.parse(l));

    expect(events.some((e) => e.type === "blocked")).toBe(true);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.some((e) => e.type === "done")).toBe(false);
  });

  // A model false-positive (the child's request was fine, the provider glitched)
  // must NOT tell the kid to "talk about something else" — they were mid-build
  // and did nothing wrong. It owns the hiccup and invites a retry instead
  // (owner call 2026-07-21; BUG-FIX-LOG false-positive-on-valid-edit).
  it("uses the retry copy — NOT the topic-change redirect — for a model glitch", async () => {
    replyStreamMock.mockReturnValue((async function* (): AsyncGenerator<never> {
      throw new SafetyBlockedError("gemini-3-flash-preview");
    })());

    const res = await POST(makeReq({ message: "put the score below the car", history: [] }));
    const text = await res.text();
    const blocked = text.trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.type === "blocked");

    expect(blocked?.text).toBe(MODEL_GLITCH_RETRY);
    expect(blocked?.text).not.toBe(KIND_REDIRECT);
  });

  // Teacher mode (verified-adult bible-teacher persona): an HONEST, actionable
  // safety-block message that names what tripped — NOT the kid "tell me more"
  // redirect, which doesn't help an adult author find a fix (owner ask
  // 2026-07-23).
  it("gives a verified-adult teacher an HONEST safety-block message, not the kid retry copy", async () => {
    authMock.mockResolvedValue({ userId: "user:teacher@example.com", email: "teacher@example.com", name: "Teacher", adult: true });
    replyStreamMock.mockReturnValue((async function* (): AsyncGenerator<never> {
      throw new SafetyBlockedError("gemini-3-flash-preview", "HARASSMENT:MEDIUM, HATE_SPEECH:NEGLIGIBLE");
    })());

    const res = await POST(makeReq({ message: "remove the leaderboard", history: [], persona: "bible-teacher" }));
    const text = await res.text();
    const blocked = text.trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.type === "blocked");

    expect(blocked?.text).not.toBe(MODEL_GLITCH_RETRY);
    expect(blocked?.text).toMatch(/content-safety/i);
    expect(blocked?.text).toContain("harassment"); // names the category that tripped
  });
});

describe("POST /api/chat — genuine input block keeps the gentle topic-change redirect", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(null);
  });

  it("a hard-blocked INPUT still gets KIND_REDIRECT (not the model-glitch retry), and never calls Gemini", async () => {
    ruleVerdict = { category: "profanity", severity: "high", action: "hard_block", reason: "Matched blocked term (rule)." };

    const res = await POST(makeReq({ message: "something the rules block", history: [] }));
    const text = await res.text();
    const blocked = text.trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.type === "blocked");

    expect(blocked?.text).toBe(KIND_REDIRECT);
    expect(blocked?.text).not.toBe(MODEL_GLITCH_RETRY);
    expect(replyStreamMock).not.toHaveBeenCalled();
  });
});

// KNOWN_BUGS #7/#12 (2026-07-27): a re-attached ~100K-char game body used to
// get folded into `message` client-side and hard-blocked by the deterministic
// rules scan. attachmentText now travels as its own field — this is the
// regression test proving the rules classifier only ever sees the child's
// own typed words, never the attachment's contents.
describe("POST /api/chat — attachment content never reaches the safety rules scan (KNOWN_BUGS #7/#12)", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(null);
    replyStreamMock.mockReturnValue(one("ok"));
  });

  it("scans only the short typed instruction, not a huge attached file's contents", async () => {
    const hugeAttachment = "<html><head></head><body>".repeat(5000); // ~125K chars, benign
    const res = await POST(
      makeReq({
        message: "can you fix the jump button",
        attachmentText: hugeAttachment,
        attachmentName: "my-game.js",
        history: [],
      }),
    );
    await res.text();

    expect(classifySyncCalls).toHaveLength(1);
    expect(classifySyncCalls[0]!.text).toBe("can you fix the jump button");
    expect(classifySyncCalls[0]!.text.length).toBeLessThan(100);
    // The model still receives the full attachment content — only the safety
    // scan's input narrowed, not what the model is told.
    const [{ message: modelMessage }] = replyStreamMock.mock.calls[0]!;
    expect(modelMessage).toContain(hugeAttachment);
    expect(modelMessage).toContain("can you fix the jump button");
  });

  it("still hard-blocks when the child's OWN typed instruction is the problem, attachment or not", async () => {
    ruleVerdict = { category: "profanity", severity: "high", action: "hard_block", reason: "Matched blocked term (rule)." };
    const res = await POST(
      makeReq({
        message: "something the rules block",
        attachmentText: "<html><head></head><body>ordinary game code</body></html>",
        attachmentName: "my-game.html",
        history: [],
      }),
    );
    const text = await res.text();
    const blocked = text.trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.type === "blocked");

    expect(blocked?.text).toBe(KIND_REDIRECT);
    expect(replyStreamMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/chat — cheap strict-edit rung before full rebuild (PRD-RESILIENT-GENERATION §6, Option 6)", () => {
  const CURRENT_GAME = '<!doctype html><html><body><div id="score">0</div><div>OLD_FEATURE</div></body></html>';
  const historyWithGame = [
    { id: "1", role: "child" as const, text: "make me a game", createdAt: 1 },
    {
      id: "2", role: "assistant" as const,
      text: "Here!\n```html\n" + CURRENT_GAME + "\n```",
      artifactHtml: CURRENT_GAME,
      createdAt: 2,
    },
  ];
  // A first patch attempt that can't apply (SEARCH text absent) → the failed-patch path.
  const badPatchReply = "Trying!\n<<<<<<< SEARCH\nTHIS_IS_NOT_IN_THE_SOURCE\n=======\nX\n>>>>>>> REPLACE";
  const done = (text: string) => JSON.parse(text.trim().split("\n").find((l) => l.includes('"done"'))!);

  beforeEach(() => {
    authMock.mockResolvedValue(null);
  });

  it("DR.1 a clean strict-rung patch rescues the game WITHOUT the expensive full rebuild", async () => {
    replyStreamMock.mockReturnValue(one(badPatchReply));
    strictEditRetryMock.mockResolvedValue({
      text: "Got it now!\n<<<<<<< SEARCH\nOLD_FEATURE\n=======\nNEW_FEATURE\n>>>>>>> REPLACE",
    });

    const res = await POST(makeReq({ message: "add a medic kit", history: historyWithGame }));
    const d = done(await res.text());

    expect(strictEditRetryMock).toHaveBeenCalledTimes(1);
    expect(replyMock).not.toHaveBeenCalled(); // the 24576-token rebuild was avoided
    expect(d.artifactHtml).toBe(CURRENT_GAME.replace("OLD_FEATURE", "NEW_FEATURE")); // patched in place
  });

  it("DR.2 when the strict rung declines (NEEDS_FULL_REBUILD), the edit soft-fails — no rebuild (owner decision 2026-08-10)", async () => {
    replyStreamMock.mockReturnValue(one(badPatchReply));
    strictEditRetryMock.mockResolvedValue({ text: "NEEDS_FULL_REBUILD" });

    const res = await POST(makeReq({ message: "add a medic kit", history: historyWithGame }));
    const d = done(await res.text());

    expect(strictEditRetryMock).toHaveBeenCalledTimes(1); // the cheap rung is still tried first…
    expect(replyMock).not.toHaveBeenCalled(); // …but a declined rung ends in soft-fail, never a rebuild
    expect(d.artifactHtml).toBeNull();
    expect(d.text).toBe(EDIT_FAILED_SOFT);
  });

  it("DR.3 a rung patch that introduces a broken import is rejected — soft-fail, never ships it, never rebuilds", async () => {
    replyStreamMock.mockReturnValue(one(badPatchReply));
    // The rung 'applies' but swaps in a bad three import; the guard must reject it.
    strictEditRetryMock.mockResolvedValue({
      text: '<<<<<<< SEARCH\nOLD_FEATURE\n=======\n<script type="module">import { FakeNonexistentThing } from "three";</script>\n>>>>>>> REPLACE',
    });

    const res = await POST(makeReq({ message: "make the car faster", history: historyWithGame }));
    const d = done(await res.text());

    expect(replyMock).not.toHaveBeenCalled();
    expect(d.artifactHtml).toBeNull(); // the import-crashing rung result is never published
    expect(d.text).toBe(EDIT_FAILED_SOFT);
  });
});

describe("POST /api/chat — Different one (PRD-INSTANT-ALTERNATE, on-demand)", () => {
  beforeEach(() => {
    authMock.mockResolvedValue(null);
  });

  it("passes differentVersion through to replyStream as preferAlternateModel", async () => {
    replyStreamMock.mockReturnValue(one("A different game!"));

    await POST(makeReq({ message: "make me a game", history: [], differentVersion: true }));

    expect(replyStreamMock).toHaveBeenCalledTimes(1);
    expect(replyStreamMock.mock.calls[0]![0]).toMatchObject({ preferAlternateModel: true });
  });

  it("a normal turn does not set preferAlternateModel", async () => {
    replyStreamMock.mockReturnValue(one("Normal game!"));

    await POST(makeReq({ message: "make me a game", history: [] }));

    expect(replyStreamMock.mock.calls[0]![0]).toMatchObject({ preferAlternateModel: false });
  });
});

// Bible-teacher persona (PRD-BIBLE-TEACHER §3a/§4). The route is the API-side
// trust boundary: it picks the smaller free-trial allowance for the surface,
// fail-closes the persona to the verified-adult session, and relaxes the
// deterministic input rules ONLY in verified-adult authoring mode.
describe("POST /api/chat — bible-teacher persona (gate + fail-closed resolution)", () => {
  const ADULT = { userId: "user:teacher@church.org", email: "teacher@church.org", name: "Pastor", adult: true };
  const NON_ADULT = { userId: "user:kid@x.com", email: "kid@x.com", adult: false };

  it("BT.1 the surface gets the SMALLER free trial — a guest over ~2k is walled even though it's under the 10k default", async () => {
    authMock.mockResolvedValue(null);
    // Between the teacher allowance and the default guest limit.
    usedByUser.mockReturnValue(BIBLE_TEACHER_GUEST_TOKEN_LIMIT + 1);
    expect(BIBLE_TEACHER_GUEST_TOKEN_LIMIT).toBeLessThan(GUEST_TOKEN_LIMIT);

    const res = await POST(makeReq({ message: "a Noah's ark game", history: [], persona: "bible-teacher" }));

    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("auth_required");
    expect(replyStreamMock).not.toHaveBeenCalled();
  });

  it("BT.2 the SAME usage on the default surface still streams (the smaller cap is surface-scoped)", async () => {
    authMock.mockResolvedValue(null);
    usedByUser.mockReturnValue(BIBLE_TEACHER_GUEST_TOKEN_LIMIT + 1); // over the teacher cap, under 10k
    replyStreamMock.mockReturnValue(one("Hi!"));

    const res = await POST(makeReq({ message: "hello", history: [] }));

    expect(res.status).toBe(200);
    expect(replyStreamMock).toHaveBeenCalledTimes(1);
  });

  it("BT.3 a guest can try the surface under the trial allowance (non-blocking entry)", async () => {
    authMock.mockResolvedValue(null);
    usedByUser.mockReturnValue(0);
    replyStreamMock.mockReturnValue(one("Here's your Bible game!"));

    const res = await POST(makeReq({ message: "a David and Goliath game", history: [], persona: "bible-teacher" }));

    expect(res.status).toBe(200);
    // …but a guest is NOT a verified adult, so the persona fail-closes to default.
    expect(replyStreamMock.mock.calls[0]![0]).toMatchObject({ persona: "default" });
  });

  it("BT.4 a VERIFIED-ADULT session unlocks the bible-teacher persona end-to-end", async () => {
    authMock.mockResolvedValue(ADULT);
    replyStreamMock.mockReturnValue(one("Here's your Bible game!"));

    await POST(makeReq({ message: "a David and Goliath game", history: [], persona: "bible-teacher" }));

    expect(replyStreamMock.mock.calls[0]![0]).toMatchObject({ persona: "bible-teacher" });
  });

  it("BT.5 a signed-in but NON-adult session requesting the persona fail-closes to default (defense in depth)", async () => {
    authMock.mockResolvedValue(NON_ADULT);
    replyStreamMock.mockReturnValue(one("Here!"));

    await POST(makeReq({ message: "a Bible game", history: [], persona: "bible-teacher" }));

    expect(replyStreamMock.mock.calls[0]![0]).toMatchObject({ persona: "default" });
  });

  it("BT.6 adult authoring mode does NOT block on a PII soft-block (an adult's own typing), and still streams", async () => {
    authMock.mockResolvedValue(ADULT);
    ruleVerdict = { category: "personal_info", severity: "medium", action: "soft_block", reason: "looks like an email" };
    replyStreamMock.mockReturnValue(one("Here's your Bible game!"));

    const res = await POST(makeReq({ message: "a game listing our church at office@church.org", history: [], persona: "bible-teacher" }));

    expect(res.status).toBe(200);
    expect(replyStreamMock).toHaveBeenCalledTimes(1);
  });

  it("BT.7 the SAME PII soft-block DOES block in the default child persona (posture unchanged for kids)", async () => {
    authMock.mockResolvedValue(null); // guest → default persona
    ruleVerdict = { category: "personal_info", severity: "medium", action: "soft_block", reason: "looks like an email" };

    const res = await POST(makeReq({ message: "my email is kid@x.com", history: [] }));
    const text = await res.text();

    expect(text).toContain('"type":"blocked"');
    expect(replyStreamMock).not.toHaveBeenCalled();
  });

  it("BT.8 a HARD block (profanity/self-harm) still blocks even in adult authoring mode — the safety floor holds", async () => {
    authMock.mockResolvedValue(ADULT);
    ruleVerdict = { category: "profanity", severity: "high", action: "hard_block", reason: "Matched blocked term (rule)." };

    const res = await POST(makeReq({ message: "something hard-blocked", history: [], persona: "bible-teacher" }));
    const text = await res.text();

    expect(text).toContain('"type":"blocked"');
    expect(replyStreamMock).not.toHaveBeenCalled();
  });
});

// 2026-08-25 PRD_EditTurnCost: the replay harness (scripts/replay-session.mjs)
// measures cost per turn from what Google actually billed. It reads the
// billed usage off the `done` frame — but ONLY when EXPOSE_TURN_USAGE=1, so a
// production client never sees token counts (they are operator data, served
// by /api/usage behind ADMIN_SECRET).
describe("POST /api/chat — done frame carries billed usage only under EXPOSE_TURN_USAGE", () => {
  const doneOf = (text: string) => JSON.parse(text.trim().split("\n").find((l) => l.includes('"type":"done"'))!);
  async function* withUsage(text: string) {
    yield { kind: "delta", text };
    yield {
      kind: "usage",
      text: "",
      model: "gemini-3.7-flash",
      usage: { promptTokens: 20000, outputTokens: 1500, thoughtTokens: 600, cachedTokens: 8000 },
    };
  }

  it("U.1 exposes model + billed tokens + estimated cost on the done frame when the flag is on", async () => {
    vi.stubEnv("EXPOSE_TURN_USAGE", "1");
    authMock.mockResolvedValue(null);
    replyStreamMock.mockReturnValue(withUsage("Hello!"));

    const res = await POST(makeReq({ message: "hello", history: [] }));
    const done = doneOf(await res.text());

    expect(done.usage).toEqual({
      model: "gemini-3.7-flash",
      promptTokens: 20000,
      cachedTokens: 8000,
      outputTokens: 1500,
      thoughtTokens: 600,
      costUsd: expect.any(Number),
    });
    expect(done.usage.costUsd).toBeGreaterThan(0);
  });

  it("U.2 never exposes usage when the flag is off (default)", async () => {
    authMock.mockResolvedValue(null);
    replyStreamMock.mockReturnValue(withUsage("Hello!"));

    const res = await POST(makeReq({ message: "hello", history: [] }));
    const done = doneOf(await res.text());

    expect(done.usage).toBeUndefined();
  });
});
