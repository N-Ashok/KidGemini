// POST /api/perf/slow-game — server-visible slow-game reporting (2026-08-04).
// Fired by ArtifactFrame.tsx when the kid-facing "running slow" banner
// (slowdown-nudge.ts) becomes visible. Fail-open by design (same shape as
// /api/screen-time/heartbeat): a reporting failure must never surface to the
// kid's session, so this ALWAYS returns 200 { ok: true } and only ever logs
// (never throws) on a malformed or oversized body.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

import { POST } from "./route";
import type { NextRequest } from "next/server";

function makeReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

describe("POST /api/perf/slow-game", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("P.1 a valid report logs a [perf] line and returns ok:true", async () => {
    const res = await POST(
      makeReq({
        docKey: "doc-1",
        fps: 12,
        heaviestModel: { name: "grandpa", instances: 3, animated: true },
        conversationId: "conv-1",
        chatId: "chat-1",
        messageId: "msg-1",
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [line] = warnSpy.mock.calls[0]!;
    expect(String(line)).toContain("[perf]");
    expect(String(line)).toContain("grandpa");
  });

  it("P.1b drawCalls lands in the log line when present, and its absence logs nothing odd (2026-08-10)", async () => {
    warnSpy.mockClear();
    await POST(makeReq({ docKey: "doc-1", fps: 20, heaviestModel: null, drawCalls: 1250 }));
    expect(String(warnSpy.mock.calls.at(-1)![0])).toContain("drawCalls=1250");
    await POST(makeReq({ docKey: "doc-1", fps: 20, heaviestModel: null }));
    expect(String(warnSpy.mock.calls.at(-1)![0])).not.toContain("drawCalls");
  });

  it("P.2 a report with no heaviest model (pure 2D game) still logs and returns ok:true", async () => {
    const res = await POST(makeReq({ docKey: "doc-1", fps: 10, heaviestModel: null }));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("P.3 a malformed body (missing docKey/fps) fails open — logs nothing malformed, still 200", async () => {
    const res = await POST(makeReq({ nonsense: true }));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("P.4 a body that isn't even valid JSON fails open (json() throws) — still 200, never a 500", async () => {
    const req = { json: async () => { throw new Error("bad json"); } } as unknown as NextRequest;
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("P.5 an oversized fps (NaN/Infinity from a hostile or buggy client) never crashes the route", async () => {
    const res = await POST(makeReq({ docKey: "doc-1", fps: Number.POSITIVE_INFINITY, heaviestModel: null }));
    expect(res.status).toBe(200);
  });
});
