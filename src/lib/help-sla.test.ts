// The 16-hour reply target (docs/PRD-COMMUNITY-HELP.md, owner call 2026-07-28).
// ONE constant drives both the kid-facing promise ("by tomorrow") and the admin
// queue's colouring, so the promise and the dashboard can never drift apart.
import { describe, it, expect } from "vitest";
import {
  HELP_REPLY_TARGET_HOURS,
  HELP_REPLY_TARGET_MS,
  HELP_DUE_SOON_MS,
  ticketAgeState,
  formatWaiting,
} from "./help-sla";

const H = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

describe("the reply target", () => {
  it("S.1 is 16 hours — the span that makes 'by tomorrow' keepable from any waking hour", () => {
    expect(HELP_REPLY_TARGET_HOURS).toBe(16);
    expect(HELP_REPLY_TARGET_MS).toBe(16 * H);
  });

  it("S.2 warns at half the target, so there is time to act before it's missed", () => {
    expect(HELP_DUE_SOON_MS).toBe(8 * H);
    expect(HELP_DUE_SOON_MS).toBeLessThan(HELP_REPLY_TARGET_MS);
  });
});

describe("ticketAgeState", () => {
  it("S.3 a just-filed ticket is fresh", () => {
    expect(ticketAgeState(NOW, NOW)).toBe("fresh");
    expect(ticketAgeState(NOW - 30 * 60 * 1000, NOW)).toBe("fresh");
  });

  it("S.4 crosses to due exactly AT the 8h mark, not a millisecond before", () => {
    expect(ticketAgeState(NOW - (HELP_DUE_SOON_MS - 1), NOW)).toBe("fresh");
    expect(ticketAgeState(NOW - HELP_DUE_SOON_MS, NOW)).toBe("due");
  });

  it("S.5 crosses to overdue exactly AT the 16h target", () => {
    expect(ticketAgeState(NOW - (HELP_REPLY_TARGET_MS - 1), NOW)).toBe("due");
    expect(ticketAgeState(NOW - HELP_REPLY_TARGET_MS, NOW)).toBe("overdue");
    expect(ticketAgeState(NOW - 40 * H, NOW)).toBe("overdue");
  });

  it("S.6 a clock skew that puts createdAt in the future reads as fresh, never overdue", () => {
    expect(ticketAgeState(NOW + 5 * H, NOW)).toBe("fresh");
  });
});

describe("formatWaiting", () => {
  it("S.7 reads in the units an operator scans by", () => {
    expect(formatWaiting(0)).toBe("just now");
    expect(formatWaiting(45_000)).toBe("just now");
    expect(formatWaiting(12 * 60 * 1000)).toBe("12m");
    expect(formatWaiting(15 * H + 40 * 60 * 1000)).toBe("15h 40m");
    expect(formatWaiting(3 * H)).toBe("3h");
    expect(formatWaiting(50 * H)).toBe("2d 2h");
  });

  it("S.8 never renders a negative wait", () => {
    expect(formatWaiting(-5000)).toBe("just now");
  });
});
