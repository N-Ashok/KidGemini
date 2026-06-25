// Integration test for the /api/chat auth gate (CLAUDE.md §7.4 "auth identity resolution").
// Contract: unauthenticated callers are rejected fail-closed (HTTP 401) and never reach Gemini —
// closing the anonymous LLM-cost path. Authenticated callers stream as before.
//
// Collaborators are mocked so no real Gemini, SQLite, or log file is touched.

import { describe, it, expect, vi, beforeEach } from "vitest";

// auth() — toggled per test.
const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: () => authMock() }));

// Logger side-effect import — keep it from writing logs/app.log during tests.
vi.mock("@/lib/logger", () => ({}));

// "server-only" guards source files from client bundles; it has no meaning in the node test env.
vi.mock("server-only", () => ({}));

// Gemini — spy so we can assert it is NEVER called for unauthenticated requests.
const replyStreamMock = vi.fn();
vi.mock("@/lib/gemini", () => ({
  GeminiChatModel: class {
    replyStream(...args: unknown[]) {
      return replyStreamMock(...args);
    }
  },
  // real-ish passthrough; the route only needs { text, artifactHtml }
  extractArtifact: (t: string) => ({ text: t, artifactHtml: undefined }),
}));

// Safety classifiers — always allow (we're testing the auth gate, not safety).
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

// DB stores — in-memory no-ops so no real .db file is opened/touched.
vi.mock("@/lib/db", () => ({
  SqliteAlertStore: class {
    record() {}
  },
  SqliteUsageStore: class {
    record() {}
    tokensUsedByUser() {
      return 0;
    }
  },
  SqliteRateLimitStore: class {
    hit() {
      return { state: "ok" };
    }
  },
}));

import { POST } from "./route";

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

describe("POST /api/chat — auth gate (fail-closed)", () => {
  beforeEach(() => {
    authMock.mockReset();
    replyStreamMock.mockReset();
  });

  it("rejects unauthenticated requests with 401 and never calls Gemini", async () => {
    authMock.mockResolvedValue(null); // no session → guest

    const res = await POST(makeReq({ message: "hello", history: [] }));

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("auth_required");
    expect(replyStreamMock).not.toHaveBeenCalled();
  });

  it("allows authenticated requests to stream", async () => {
    authMock.mockResolvedValue({ user: { email: "kid@example.com" } });
    replyStreamMock.mockReturnValue(one("Hi there!"));

    const res = await POST(makeReq({ message: "hello", history: [] }));

    expect(res.status).toBe(200);
    expect(replyStreamMock).toHaveBeenCalledTimes(1);
    const text = await res.text();
    expect(text).toContain('"type":"delta"');
    expect(text).toContain("Hi there!");
    expect(text).toContain('"type":"done"');
  });
});
