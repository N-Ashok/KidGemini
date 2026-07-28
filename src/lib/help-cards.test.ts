// The Help Gallery's content (docs/PRD-COMMUNITY-HELP.md Phase 2).
//
// Cards are team-authored and repo-committed — zero user content, therefore
// zero runtime moderation, which is the whole reason this phase is cheap. What
// still needs pinning is that every card is USABLE BY A PRE-READER: a prompt
// that Ari can actually act on, read-aloud text, and no markup anywhere near it.
import { describe, it, expect } from "vitest";
import { HELP_CARDS, helpCardsFor, helpCardById } from "./help-cards";
import { HELP_REASON_CODES } from "@/types/help.types";

describe("every card", () => {
  it("G.1 has a unique id", () => {
    const ids = HELP_CARDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("G.2 carries a prompt Ari can build from — the whole feature is one tap", () => {
    for (const card of HELP_CARDS) {
      expect(card.prompt.trim().length, card.id).toBeGreaterThan(10);
      // It must read as an instruction, not a heading: a pre-reader taps the
      // picture and this is what gets SENT, verbatim, through the normal chat.
      expect(card.prompt).not.toMatch(/^[A-Z][a-z]+ [a-z]+\?$/);
    }
  });

  it("G.3 has read-aloud text, so a kid who can't read can still use it", () => {
    for (const card of HELP_CARDS) {
      expect(card.readAloud.trim().length, card.id).toBeGreaterThan(5);
    }
  });

  it("G.4 contains NO markup — cards are rendered as text, never as HTML (XSS pin)", () => {
    for (const card of HELP_CARDS) {
      for (const field of [card.title, card.prompt, card.readAloud, card.emoji]) {
        expect(field, card.id).not.toMatch(/[<>]/);
      }
    }
  });

  it("G.5 keeps titles short enough for a card on a phone", () => {
    for (const card of HELP_CARDS) {
      expect(card.title.length, card.id).toBeLessThanOrEqual(44);
    }
  });

  it("G.6 tags a reason code that exists — the 🆘 sheet's 🤷 chip lands on these", () => {
    for (const card of HELP_CARDS) {
      expect(HELP_REASON_CODES, card.id).toContain(card.reasonCode);
    }
  });
});

describe("lookup", () => {
  it("G.7 groups by reason, and every reason a kid can pick has at least one card", () => {
    // 'other' is the mic path — it has no gallery answer by design.
    for (const code of HELP_REASON_CODES.filter((c) => c !== "other")) {
      expect(helpCardsFor(code).length, `no card for ${code}`).toBeGreaterThan(0);
    }
  });

  it("G.8 finds a card by id, and an unknown id is null", () => {
    expect(helpCardById(HELP_CARDS[0]!.id)?.id).toBe(HELP_CARDS[0]!.id);
    expect(helpCardById("nope")).toBeNull();
  });

  it("G.9 ships enough cards that the page never looks empty", () => {
    expect(HELP_CARDS.length).toBeGreaterThanOrEqual(6);
  });
});
