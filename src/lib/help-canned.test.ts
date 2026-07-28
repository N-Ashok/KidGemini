// The committed reply library (docs/PRD-COMMUNITY-HELP.md §3.8 constraint 1).
// A canned reply is pre-approved text an adult sends to a child, so its
// properties are pinned: every reason has one, none of them promise a time we
// can't keep, and none of them address the child as a stranger would.
import { describe, it, expect } from "vitest";
import { CANNED_REPLIES, cannedById, cannedFor } from "./help-canned";
import { HELP_REASON_CODES } from "@/types/help.types";

describe("the canned library", () => {
  it("C.1 covers every reason code, so no ticket can arrive with nothing to send", () => {
    for (const code of HELP_REASON_CODES) {
      expect(cannedFor(code).length, `no canned reply for ${code}`).toBeGreaterThan(0);
    }
  });

  it("C.2 has unique ids — cannedId is what proves a reply needed no review", () => {
    const ids = CANNED_REPLIES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("C.3 looks up by id, and an unknown id is null (so a route can 400)", () => {
    expect(cannedById(CANNED_REPLIES[0]!.id)?.id).toBe(CANNED_REPLIES[0]!.id);
    expect(cannedById("no-such-canned")).toBeNull();
  });

  it("C.4 never promises a response time — one admin can't keep 'soon'", () => {
    for (const reply of CANNED_REPLIES) {
      expect(reply.body.toLowerCase(), reply.id).not.toMatch(
        /\b(soon|shortly|right away|immediately|in a (few|couple) (minutes|hours)|within \d+)\b/,
      );
    }
  });

  it("C.5 asks for nothing personal — a helper never solicits a child's details", () => {
    for (const reply of CANNED_REPLIES) {
      // Solicitations only — "tablet or phone" is fine, "your phone number" is not.
      expect(reply.body.toLowerCase(), reply.id).not.toMatch(
        /\b(your (name|age|email|address|password|school)|phone number|where do you live|how old are you|send (me )?a (photo|picture) of you)\b/,
      );
    }
  });

  it("C.6 every reply is short enough for a kid to read in one breath", () => {
    for (const reply of CANNED_REPLIES) {
      expect(reply.body.length, `${reply.id} is too long`).toBeLessThanOrEqual(240);
      expect(reply.body.trim().length).toBeGreaterThan(20);
    }
  });

  it("C.7 each reply carries an operator label distinct from the kid-facing body", () => {
    for (const reply of CANNED_REPLIES) {
      expect(reply.label.length).toBeGreaterThan(0);
      expect(reply.label).not.toBe(reply.body);
    }
  });
});
