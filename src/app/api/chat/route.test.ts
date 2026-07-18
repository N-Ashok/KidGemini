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
// One-shot reply — used ONLY by the patch-fallback path (a failed edit-patch
// falls back to a full regeneration, BUG-FIX-LOG class fix 2026-07-18).
const replyMock = vi.fn();
const extractArtifactMock = vi.fn((t: string): { text: string; artifactHtml?: string } => ({ text: t, artifactHtml: undefined }));
vi.mock("@/lib/gemini", () => ({
  GeminiChatModel: class {
    replyStream(...args: unknown[]) {
      return replyStreamMock(...args);
    }
    reply(...args: unknown[]) {
      return replyMock(...args);
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
  replyMock.mockResolvedValue({ text: "fallback" });
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

  it("an off-topic reply (no patch, no full doc) passes through as ordinary chat — the game is untouched and no extra Gemini call is wasted", async () => {
    replyStreamMock.mockReturnValue(one("Pandas eat bamboo! 🐼"));

    const res = await POST(makeReq({ message: "what do pandas eat?", history: historyWithGame }));
    const text = await res.text();
    const done = JSON.parse(text.trim().split("\n").find((l) => l.includes('"done"'))!);

    expect(done.text).toBe("Pandas eat bamboo! 🐼");
    expect(done.artifactHtml).toBeFalsy(); // game untouched — no new artifact sent
    expect(replyMock).not.toHaveBeenCalled(); // key: no wasted full-regeneration call
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
