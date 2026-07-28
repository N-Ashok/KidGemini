// The kid-side view of their help tickets (docs/PRD-COMMUNITY-HELP.md).
//
// The 16h reply target means the child is normally AWAY when the answer lands,
// so this state is derived from the server's ticket list on every boot — never
// from an in-memory flag. That's the class of bug that lost a reply in
// BUG-FIX-LOG 2026-07-28, and these tests are what stop it recurring here.
import { describe, it, expect } from "vitest";
import {
  deriveHelpView,
  helpButtonEnabled,
  helpNudgeEnabled,
  loadSeenReplies,
  markRepliesSeen,
  sentAgoLabel,
  ticketForConversation,
  type HelpTicketView,
} from "./help-client";

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

const t = (over: Partial<HelpTicketView> = {}): HelpTicketView => ({
  id: "t1",
  reasonCode: "wont_move",
  status: "open",
  conversationId: "convo-1",
  messageId: "msg-1",
  createdAt: NOW - HOUR,
  updatedAt: NOW - HOUR,
  replies: [],
  ...over,
});

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

describe("the rollout flags", () => {
  it("V.1 both default OFF — turning the button on is what creates an obligation to a child", () => {
    expect(helpButtonEnabled({})).toBe(false);
    expect(helpNudgeEnabled({})).toBe(false);
    expect(helpButtonEnabled({ NEXT_PUBLIC_ENABLE_HELP_BUTTON: "0" })).toBe(false);
  });

  it("V.2 the nudge needs BOTH flags — it can't spike volume while the button is off", () => {
    expect(helpNudgeEnabled({ NEXT_PUBLIC_ENABLE_HELP_NUDGE: "1" })).toBe(false);
    expect(
      helpNudgeEnabled({ NEXT_PUBLIC_ENABLE_HELP_BUTTON: "1", NEXT_PUBLIC_ENABLE_HELP_NUDGE: "1" }),
    ).toBe(true);
  });

  it("V.3 the button turns on with an explicit 1", () => {
    expect(helpButtonEnabled({ NEXT_PUBLIC_ENABLE_HELP_BUTTON: "1" })).toBe(true);
  });
});

describe("deriveHelpView", () => {
  it("V.4 a ticket still with a helper is 'waiting', with nothing for the kid to do", () => {
    const view = deriveHelpView([t()], []);
    expect(view.waiting.map((x) => x.id)).toEqual(["t1"]);
    expect(view.answered).toEqual([]);
    expect(view.unreadCount).toBe(0);
  });

  it("V.5 an answered ticket the kid hasn't seen drives the 📬 badge", () => {
    const answered = t({
      status: "answered",
      replies: [{ id: "r1", body: "try tap controls", createdAt: NOW, canned: true }],
    });
    const view = deriveHelpView([answered], []);
    expect(view.answered.map((x) => x.id)).toEqual(["t1"]);
    expect(view.unreadCount).toBe(1);
  });

  it("V.6 once that reply has been shown, the badge clears but the card stays readable", () => {
    const answered = t({
      status: "answered",
      replies: [{ id: "r1", body: "try tap controls", createdAt: NOW, canned: true }],
    });
    const view = deriveHelpView([answered], ["r1"]);
    expect(view.unreadCount).toBe(0);
    expect(view.answered).toHaveLength(1);
  });

  it("V.7 closed tickets are neither waiting nor unread — 👍 ends it", () => {
    const closed = t({
      status: "closed",
      replies: [{ id: "r1", body: "done", createdAt: NOW, canned: true }],
    });
    const view = deriveHelpView([closed], []);
    expect(view.waiting).toEqual([]);
    expect(view.answered).toEqual([]);
    expect(view.unreadCount).toBe(0);
  });

  it("V.8 a reply that arrived while the kid was away is still unread days later", () => {
    const old = t({
      status: "answered",
      createdAt: NOW - 72 * HOUR,
      replies: [{ id: "r1", body: "here you go", createdAt: NOW - 60 * HOUR, canned: true }],
    });
    expect(deriveHelpView([old], []).unreadCount).toBe(1);
  });

  it("V.9 an empty list is an empty view, never a crash", () => {
    const view = deriveHelpView([], []);
    expect(view).toEqual({ waiting: [], answered: [], unreadCount: 0 });
  });
});

describe("ticketForConversation", () => {
  it("V.10 finds the ticket belonging to the chat on screen, not just any ticket", () => {
    const mine = t({ id: "here", conversationId: "convo-here" });
    const other = t({ id: "elsewhere", conversationId: "convo-other" });
    expect(ticketForConversation([mine, other], "convo-here")?.id).toBe("here");
    expect(ticketForConversation([mine, other], "convo-nope")).toBeNull();
  });

  it("V.11 with no chat open, nothing is claimed", () => {
    expect(ticketForConversation([t()], null)).toBeNull();
  });
});

describe("seen-reply memory", () => {
  it("V.12 survives across sessions, so the badge doesn't reappear on every reload", () => {
    const storage = fakeStorage();
    expect(loadSeenReplies(storage)).toEqual([]);
    markRepliesSeen(storage, ["r1", "r2"]);
    expect(loadSeenReplies(storage).sort()).toEqual(["r1", "r2"]);
    markRepliesSeen(storage, ["r2", "r3"]);
    expect(loadSeenReplies(storage).sort()).toEqual(["r1", "r2", "r3"]);
  });

  it("V.13 corrupt storage fails OPEN — worst case the kid sees the badge again", () => {
    const storage = fakeStorage();
    storage.setItem("kidgemini:help-seen:v1", "{not json");
    expect(loadSeenReplies(storage)).toEqual([]);
  });

  it("V.14 a storage that throws never breaks the chat", () => {
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    expect(loadSeenReplies(throwing)).toEqual([]);
    expect(() => markRepliesSeen(throwing, ["r1"])).not.toThrow();
  });
});

describe("sentAgoLabel — how a child reads the wait", () => {
  it("V.15 speaks in days, never in hours-since-epoch", () => {
    expect(sentAgoLabel(NOW - 5 * 60 * 1000, NOW)).toBe("sent just now");
    expect(sentAgoLabel(NOW - 3 * HOUR, NOW)).toBe("sent today");
    expect(sentAgoLabel(NOW - 20 * HOUR, NOW)).toBe("sent yesterday");
    expect(sentAgoLabel(NOW - 70 * HOUR, NOW)).toBe("sent a few days ago");
  });

  it("V.16 a future timestamp (clock skew) still reads sensibly", () => {
    expect(sentAgoLabel(NOW + HOUR, NOW)).toBe("sent just now");
  });
});
