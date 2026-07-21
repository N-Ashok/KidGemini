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
import { KIND_REDIRECT, MODEL_GLITCH_RETRY } from "@/lib/chat-copy";

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
vi.mock("@/lib/safety.rules", () => ({
  RulesClassifier: class {
    classifySync() {
      return ruleVerdict;
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
  it("a truncated/malformed patch attempt is NEVER shown raw — falls back to a full regeneration instead", async () => {
    const truncatedReply = "Sure, adding that now!\n<<<<<<< SEARCH\nOLD_FEATURE\n";
    replyStreamMock.mockReturnValue(one(truncatedReply));
    replyMock.mockResolvedValue({ text: "Here you go!", artifactHtml: "<html>FALLBACK GAME</html>", wasFenced: true });

    const res = await POST(makeReq({ message: "add a medic kit", history: historyWithGame }));
    const text = await res.text();
    const done = JSON.parse(text.trim().split("\n").find((l) => l.includes('"done"'))!);

    expect(done.text).not.toContain("<<<<<<<"); // never leak raw patch markers to the chat bubble
    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(replyMock.mock.calls[0]![0]).toMatchObject({ forceFullRegen: true });
    expect(done.artifactHtml).toBe("<html>FALLBACK GAME</html>");
  });

  // Same class: applyPatch()'s "regeneration" fallback trusts ANY ```html
  // fence as a full replacement — if the model ignored the patch contract
  // and explained "here's the changed part" with a PARTIAL snippet, that
  // fragment would silently become the entire game.
  it("a partial snippet mistaken for a full document is rejected — falls back to a full regeneration instead of corrupting the game", async () => {
    const partialSnippetReply = "Here's the updated part:\n```html\n<div>MEDIC_KIT_FEATURE</div>\n```";
    replyStreamMock.mockReturnValue(one(partialSnippetReply));
    replyMock.mockResolvedValue({ text: "Here you go!", artifactHtml: "<html>FALLBACK GAME</html>", wasFenced: true });

    const res = await POST(makeReq({ message: "add a medic kit", history: historyWithGame }));
    const text = await res.text();
    const done = JSON.parse(text.trim().split("\n").find((l) => l.includes('"done"'))!);

    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(replyMock.mock.calls[0]![0]).toMatchObject({ forceFullRegen: true });
    expect(done.artifactHtml).toBe("<html>FALLBACK GAME</html>"); // never the bare <div> snippet
  });

  it("a genuinely attempted-but-mismatched patch falls back to ONE full-regeneration call — never a dead end", async () => {
    const badPatchReply = "Trying to add that!\n<<<<<<< SEARCH\nTHIS_TEXT_IS_NOT_IN_THE_SOURCE\n=======\nNEW\n>>>>>>> REPLACE";
    replyStreamMock.mockReturnValue(one(badPatchReply));
    replyMock.mockResolvedValue({ text: "Here you go!", artifactHtml: "<html>FALLBACK GAME</html>", wasFenced: true });

    const res = await POST(makeReq({ message: "add a medic kit", history: historyWithGame }));
    const text = await res.text();
    const done = JSON.parse(text.trim().split("\n").find((l) => l.includes('"done"'))!);

    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(replyMock.mock.calls[0]![0]).toMatchObject({ forceFullRegen: true });
    expect(done.artifactHtml).toBe("<html>FALLBACK GAME</html>");
  });

  // ---- Penguin-maze hardening (2026-07-18): strict retry, kill switch, honest messaging ----

  const COMPLETE_REWRITE = '<!doctype html><html><body><div id="score">0</div><div>REWRITTEN_GAME</div></body></html>';

  it("a full-rewrite reply on an edit turn triggers ONE hunks-only retry — a clean retry patch wins and the rewrite is discarded", async () => {
    replyStreamMock.mockReturnValue(one("I made it 3D!\n```html\n" + COMPLETE_REWRITE + "\n```"));
    strictEditRetryMock.mockResolvedValue({
      text: "Added the 3D look! 🎮\n<<<<<<< SEARCH\nOLD_FEATURE\n=======\nTHREE_D_FEATURE\n>>>>>>> REPLACE",
    });

    const res = await POST(makeReq({ message: "make it 3D", history: historyWithGame }));
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

    const res = await POST(makeReq({ message: "make it 3D", history: historyWithGame }));
    const text = await res.text();
    const done = JSON.parse(text.trim().split("\n").find((l) => l.includes('"done"'))!);

    expect(done.artifactHtml).toBe(COMPLETE_REWRITE);
    expect(done.text).toContain("I made it 3D!");
    expect(done.text).not.toMatch(/```|<html/i);
  });

  it("a code-only rewrite accepted after a failed retry gets the HONEST rebuilt-game line, not a bare success claim", async () => {
    replyStreamMock.mockReturnValue(one("```html\n" + COMPLETE_REWRITE + "\n```"));
    strictEditRetryMock.mockRejectedValue(new Error("model unavailable"));

    const res = await POST(makeReq({ message: "make it 3D", history: historyWithGame }));
    const text = await res.text();
    const done = JSON.parse(text.trim().split("\n").find((l) => l.includes('"done"'))!);

    expect(done.artifactHtml).toBe(COMPLETE_REWRITE); // retry failure never dead-ends the turn
    expect(done.text).toBe(REBUILT_GAME_LINE); // honest: a rebuild happened, invite bug reports
  });

  it("the fallback regeneration never shows the bare generic done-line either — substitutes the honest rebuilt-game line", async () => {
    const badPatchReply = "Trying!\n<<<<<<< SEARCH\nNOT_IN_SOURCE\n=======\nNEW\n>>>>>>> REPLACE";
    replyStreamMock.mockReturnValue(one(badPatchReply));
    replyMock.mockResolvedValue({ text: FRESH_GAME_LINE, artifactHtml: "<html>FALLBACK GAME</html>", wasFenced: true });

    const res = await POST(makeReq({ message: "add a medic kit", history: historyWithGame }));
    const text = await res.text();
    const done = JSON.parse(text.trim().split("\n").find((l) => l.includes('"done"'))!);

    expect(done.artifactHtml).toBe("<html>FALLBACK GAME</html>");
    expect(done.text).toBe(REBUILT_GAME_LINE);
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
    expect(done.artifactHtml).toBe(CLEAN_GAME);
  });

  it("L.2 if the corrective retry fails, the original is still served — floor stays 'no worse', never a dead end", async () => {
    replyStreamMock.mockReturnValue(one("Here!\n```html\n" + BAD_IMPORT_GAME + "\n```"));
    extractArtifactMock.mockImplementation(() => ({ text: "Here!", artifactHtml: BAD_IMPORT_GAME, wasFenced: true }));
    replyMock.mockRejectedValue(new Error("overloaded"));

    const res = await POST(makeReq({ message: "make me a 3d game", history: [] }));
    const text = await res.text();
    const done = JSON.parse(text.trim().split("\n").find((l) => l.includes('"done"'))!);

    expect(done.artifactHtml).toBe(BAD_IMPORT_GAME); // served, visible, repairable — not dropped
  });

  it("L.3 a clean fresh build costs NO extra Gemini call", async () => {
    replyStreamMock.mockReturnValue(one("Here!\n```html\n" + CLEAN_GAME + "\n```"));
    extractArtifactMock.mockImplementation(() => ({ text: "Here!", artifactHtml: CLEAN_GAME, wasFenced: true }));

    const res = await POST(makeReq({ message: "make me a 3d game", history: [] }));
    await res.text();

    expect(replyMock).not.toHaveBeenCalled();
  });

  it("L.4 an edit patch that INTRODUCES an unknown three import is a failed patch — falls back to full regeneration", async () => {
    const GAME = '<!doctype html><html><body><div>OLD_FEATURE</div></body></html>';
    const history = [
      { id: "1", role: "child" as const, text: "make me a game", createdAt: 1 },
      { id: "2", role: "assistant" as const, text: "Here!\n```html\n" + GAME + "\n```", artifactHtml: GAME, createdAt: 2 },
    ];
    const patchReply =
      "Added a track! 🎮\n<<<<<<< SEARCH\n<div>OLD_FEATURE</div>\n=======\n" +
      '<script type="module">import { TubeGeometry } from "three";</script>\n>>>>>>> REPLACE';
    replyStreamMock.mockReturnValue(one(patchReply));
    replyMock.mockResolvedValue({ text: "Rebuilt!", artifactHtml: CLEAN_GAME, wasFenced: true });

    const res = await POST(makeReq({ message: "add a tube track", history }));
    const text = await res.text();
    const done = JSON.parse(text.trim().split("\n").find((l) => l.includes('"done"'))!);

    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(replyMock.mock.calls[0]![0]).toMatchObject({ forceFullRegen: true });
    expect(done.artifactHtml).toBe(CLEAN_GAME); // never the import-crashing patch result
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

  it("DR.2 when the strict rung declines (NEEDS_FULL_REBUILD), it falls through to ONE full regeneration", async () => {
    replyStreamMock.mockReturnValue(one(badPatchReply));
    strictEditRetryMock.mockResolvedValue({ text: "NEEDS_FULL_REBUILD" });
    replyMock.mockResolvedValue({ text: "Here you go!", artifactHtml: "<html>REBUILT GAME</html>", wasFenced: true });

    const res = await POST(makeReq({ message: "add a medic kit", history: historyWithGame }));
    const d = done(await res.text());

    expect(strictEditRetryMock).toHaveBeenCalledTimes(1); // tried the cheap rung first…
    expect(replyMock).toHaveBeenCalledTimes(1); // …then the rebuild, exactly once
    expect(replyMock.mock.calls[0]![0]).toMatchObject({ forceFullRegen: true });
    expect(d.artifactHtml).toBe("<html>REBUILT GAME</html>");
  });

  it("DR.3 a rung patch that introduces a broken import is rejected — still falls through to rebuild", async () => {
    replyStreamMock.mockReturnValue(one(badPatchReply));
    // The rung 'applies' but swaps in a bad three import; the guard must reject it.
    strictEditRetryMock.mockResolvedValue({
      text: '<<<<<<< SEARCH\nOLD_FEATURE\n=======\n<script type="module">import { FakeNonexistentThing } from "three";</script>\n>>>>>>> REPLACE',
    });
    replyMock.mockResolvedValue({ text: "Rebuilt!", artifactHtml: "<html>REBUILT</html>", wasFenced: true });

    const res = await POST(makeReq({ message: "make it 3d", history: historyWithGame }));
    const d = done(await res.text());

    // rung patch rejected for the bad import → full rebuild
    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(d.artifactHtml).toBe("<html>REBUILT</html>");
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
