// Server-visible slow-game reporting (2026-08-04). The kid-facing banner
// (slowdown-nudge.ts) and the debug Perf tab (assets/perf-probe.ts) already
// detect a sustained slowdown client-side, but neither told anyone outside
// that one browser tab — an owner asking "is this game actually slow" had no
// way to check without manually opening it with the debug flag on. This
// turns a detected slowdown into one `[perf]`-tagged log line (logger.ts's
// existing console patch → logs/app.log + pm2 stdout), reusing the SAME
// heaviest-model logic as the kid-facing hint (heaviestModel, slowdown-nudge.ts)
// so the log and the fix-request Ari sees never disagree about the culprit.
//
// Pure builder here, framework-free — the fetch call itself (reportSlowGame)
// is a thin, untested-by-design wrapper; ArtifactFrame.tsx just fires it.
import { describe, expect, it } from "vitest";
import { buildSlowGameReport } from "./perf-report";
import type { PerfModelEntry } from "@/types/preview-perf.types";

function model(overrides: Partial<PerfModelEntry> = {}): PerfModelEntry {
  return {
    name: "grandpa",
    triangles: 40_000,
    instances: 3,
    animated: true,
    load: 240_000,
    bucket: "red",
    ...overrides,
  };
}

describe("buildSlowGameReport — the payload logged when the kid-facing slowdown banner fires", () => {
  it("carries the fps and the heaviest model's name/instances/animated state", () => {
    const report = buildSlowGameReport({
      docKey: "doc-1",
      fps: 12,
      models: [model({ name: "fielder", load: 1_000 }), model({ name: "grandpa", load: 240_000 })],
    });
    expect(report.fps).toBe(12);
    expect(report.heaviestModel).toEqual({ name: "grandpa", instances: 3, animated: true });
  });

  it("heaviestModel is null for a scene with nothing tracked (a pure 2D game)", () => {
    const report = buildSlowGameReport({ docKey: "doc-1", fps: 10, models: [] });
    expect(report.heaviestModel).toBeNull();
  });

  it("rounds a fractional fps down to a whole number (fps is already an estimate, no point logging noise)", () => {
    const report = buildSlowGameReport({ docKey: "doc-1", fps: 14.7, models: [] });
    expect(report.fps).toBe(14);
  });

  it("passes through conversationId/chatId/messageId when given, omits them when absent", () => {
    const withIds = buildSlowGameReport({
      docKey: "doc-1",
      fps: 10,
      models: [],
      conversationId: "conv-1",
      chatId: "chat-1",
      messageId: "msg-1",
    });
    expect(withIds).toMatchObject({ conversationId: "conv-1", chatId: "chat-1", messageId: "msg-1" });

    const withoutIds = buildSlowGameReport({ docKey: "doc-1", fps: 10, models: [] });
    expect(withoutIds.conversationId).toBeUndefined();
    expect(withoutIds.chatId).toBeUndefined();
    expect(withoutIds.messageId).toBeUndefined();
  });

  it("truncates an implausibly long docKey/id rather than logging an unbounded string (fail-safe against a hostile/buggy client)", () => {
    const report = buildSlowGameReport({
      docKey: "x".repeat(500),
      fps: 10,
      models: [],
      conversationId: "y".repeat(500),
    });
    expect(report.docKey.length).toBeLessThanOrEqual(100);
    expect(report.conversationId?.length).toBeLessThanOrEqual(100);
  });
});
