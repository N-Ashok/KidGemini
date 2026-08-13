import { describe, it, expect } from "vitest";
import {
  applyRecoveredReply,
  applyRepairedArtifact,
  noteStillWorking,
  RECOVERY_WORKING_NOTE,
  RECOVERY_LOST_NOTE,
  RECOVERY_MAX_AGE_MS,
  keepBookmark,
} from "./turn-recovery";
import type { Conversation } from "@/types/chat.types";

const convo = (id: string, replyText: string, replyId = "r1"): Conversation => ({
  id,
  title: "Space game",
  messages: [
    { id: "m1", role: "child", text: "make a space game", createdAt: 1 },
    { id: replyId, role: "assistant", text: replyText, createdAt: 2 },
  ],
});

describe("applyRecoveredReply — the server's finished reply lands in the waiting bubble", () => {
  it("replaces the partial text and attaches the game", () => {
    const out = applyRecoveredReply([convo("c1", "📶 Reconnecting… hang tight!")], { convoId: "c1", replyId: "r1" }, { text: "All done!", artifactHtml: "<html>g</html>" });
    expect(out.patched).toBe(true);
    expect(out.convos[0]!.messages[1]).toMatchObject({ text: "All done!", artifactHtml: "<html>g</html>" });
  });

  // The kid left chat A, came back, and the app auto-restored a DIFFERENT chat
  // as active: the reply still belongs to A wherever A sits in the list.
  it("targets the turn's own chat, not the active one", () => {
    const out = applyRecoveredReply(
      [convo("c-other", "unrelated", "r9"), convo("c1", "…", "r1")],
      { convoId: "c1", replyId: "r1" },
      { text: "landed", artifactHtml: null },
    );
    expect(out.convos[0]!.messages[1]!.text).toBe("unrelated");
    expect(out.convos[1]!.messages[1]!.text).toBe("landed");
  });

  // A server-only chat (this device never cached it) must not silently eat the
  // reply — the caller fetches the convo and retries, so it needs to KNOW.
  it("reports patched=false when the chat isn't loaded on this device", () => {
    const out = applyRecoveredReply([convo("c-other", "x", "r9")], { convoId: "c1", replyId: "r1" }, { text: "landed", artifactHtml: null });
    expect(out.patched).toBe(false);
    expect(out.convos[0]!.messages[1]!.text).toBe("x");
  });

  // The bubble may be gone (kid deleted the message / rewound): don't invent one.
  it("reports patched=false when the reply bubble no longer exists", () => {
    const out = applyRecoveredReply([convo("c1", "x", "r-different")], { convoId: "c1", replyId: "r1" }, { text: "landed", artifactHtml: null });
    expect(out.patched).toBe(false);
  });

  it("strips a stale working note before applying the real reply", () => {
    const withNote = applyRecoveredReply(
      noteStillWorking([convo("c1", "partial code…")], { convoId: "c1", replyId: "r1" }, RECOVERY_WORKING_NOTE).convos,
      { convoId: "c1", replyId: "r1" },
      { text: "final", artifactHtml: null },
    );
    expect(withNote.convos[0]!.messages[1]!.text).toBe("final");
  });
});

// BUG-FIX-LOG 2026-08-13: the browser self-heals a broken generation
// automatically (usePreviewVerify/PreviewVerifyController), but the patched
// HTML only ever lived in that in-tab controller's own state — nothing wrote
// it back to the stored conversation. Every reload/reopen started over from
// the ORIGINAL, still-broken artifact, re-verified, re-repaired, and threw
// the fix away again — confirmed live: the same River Nomad game was
// auto-"repaired" 5 times across 2+ hours and was still broken every time.
describe("applyRepairedArtifact — a successful self-heal patch lands in the stored game", () => {
  it("replaces the message's artifactHtml, leaving its text untouched", () => {
    const out = applyRepairedArtifact(
      [convo("c1", "Here's your game!")],
      { convoId: "c1", replyId: "r1" },
      "<html>fixed</html>",
    );
    expect(out.patched).toBe(true);
    expect(out.convos[0]!.messages[1]).toMatchObject({ text: "Here's your game!", artifactHtml: "<html>fixed</html>" });
  });

  it("targets the game's own chat, not necessarily the active one", () => {
    const out = applyRepairedArtifact(
      [convo("c-other", "unrelated", "r9"), convo("c1", "…", "r1")],
      { convoId: "c1", replyId: "r1" },
      "<html>fixed</html>",
    );
    expect(out.convos[0]!.messages[1]!.artifactHtml).toBeUndefined();
    expect(out.convos[1]!.messages[1]!.artifactHtml).toBe("<html>fixed</html>");
  });

  it("reports patched=false when the message no longer exists (deleted/rewound) — never invents one", () => {
    const out = applyRepairedArtifact([convo("c1", "x", "r-different")], { convoId: "c1", replyId: "r1" }, "<html>fixed</html>");
    expect(out.patched).toBe(false);
  });
});

describe("noteStillWorking — the waiting bubble says what's happening", () => {
  it("appends the note to whatever already streamed", () => {
    const out = noteStillWorking([convo("c1", "here's the start")], { convoId: "c1", replyId: "r1" }, RECOVERY_WORKING_NOTE);
    expect(out.convos[0]!.messages[1]!.text).toBe(`here's the start${RECOVERY_WORKING_NOTE}`);
  });

  it("is idempotent — polling for minutes must not stack notes", () => {
    const once = noteStillWorking([convo("c1", "start")], { convoId: "c1", replyId: "r1" }, RECOVERY_WORKING_NOTE).convos;
    const twice = noteStillWorking(once, { convoId: "c1", replyId: "r1" }, RECOVERY_WORKING_NOTE).convos;
    expect(twice[0]!.messages[1]!.text).toBe(`start${RECOVERY_WORKING_NOTE}`);
  });

  it("swaps one note for another (working → lost) instead of appending", () => {
    const working = noteStillWorking([convo("c1", "start")], { convoId: "c1", replyId: "r1" }, RECOVERY_WORKING_NOTE).convos;
    const lost = noteStillWorking(working, { convoId: "c1", replyId: "r1" }, RECOVERY_LOST_NOTE).convos;
    expect(lost[0]!.messages[1]!.text).toBe(`start${RECOVERY_LOST_NOTE}`);
  });

  it("a bubble with nothing streamed shows the note alone, not a leading rule", () => {
    const out = noteStillWorking([convo("c1", "")], { convoId: "c1", replyId: "r1" }, RECOVERY_WORKING_NOTE);
    expect(out.convos[0]!.messages[1]!.text).not.toMatch(/^\s*\n/);
    expect(out.convos[0]!.messages[1]!.text).toContain("still finishing");
  });
});

// THE bug (BUG-FIX-LOG 2026-07-28): recovery deleted its bookmark up front and
// gave the server 6s. A turn still `running` — the normal case, builds take
// minutes — was then unrecoverable forever.
describe("keepBookmark — only a finished-or-gone turn releases the bookmark", () => {
  it("keeps it while the server is still generating", () => {
    expect(keepBookmark({ status: "running" })).toBe(true);
    expect(keepBookmark({ status: "running" }, 4 * 60 * 1000)).toBe(true);
  });

  // A deploy/crash leaves the row `running` with nobody generating: without an
  // age bound the kid would see "still finishing" on every load until the 24h TTL.
  it("stops believing a `running` turn that is far too old", () => {
    expect(keepBookmark({ status: "running" }, RECOVERY_MAX_AGE_MS + 1)).toBe(false);
  });

  it("drops it once there is nothing left to collect", () => {
    expect(keepBookmark({ status: "done", text: "x", artifactHtml: null })).toBe(false);
    expect(keepBookmark({ status: "error" })).toBe(false);
    expect(keepBookmark({ status: "unknown" })).toBe(false);
  });
});
