// Edit-a-launched-game entry (PRD-STUDIO-CHAT-EDIT, revised 2026-07-24 — Ari
// is the editor). Studio links here as /?edit=<slug>&chat=<chatId?>; these pure
// helpers decide what that means: open the linked chat, or seed a fresh chat
// with the live game's code, bound so Publish updates the same subdomain.
import { describe, it, expect } from "vitest";
import {
  parseEditEntry,
  stripEditParams,
  seedingConversation,
  applySeed,
  applySeedFailure,
  SEEDING_TEXT,
} from "./edit-entry";

describe("parseEditEntry", () => {
  it("EE.1 parses slug + chat id from a Studio deep link", () => {
    expect(parseEditEntry("?edit=space-dodger&chat=convo-1")).toEqual({ slug: "space-dodger", chatId: "convo-1" });
  });

  it("EE.2 chat id is optional; edit slug is required", () => {
    expect(parseEditEntry("?edit=space-dodger")).toEqual({ slug: "space-dodger", chatId: null });
    expect(parseEditEntry("?chat=convo-1")).toBeNull();
    expect(parseEditEntry("")).toBeNull();
  });

  it("EE.3 rejects malformed slugs and oversized chat ids (fail closed)", () => {
    expect(parseEditEntry("?edit=<script>")).toBeNull();
    expect(parseEditEntry("?edit=x")).toBeNull(); // below platform's 2-char slug floor
    expect(parseEditEntry(`?edit=ok-game&chat=${"x".repeat(101)}`)).toEqual({ slug: "ok-game", chatId: null });
  });

  it("EE.4 strips only the edit params from the URL (no-URL-jumps rule), keeping the path", () => {
    expect(stripEditParams("/?edit=space-dodger&chat=convo-1")).toBe("/");
    expect(stripEditParams("/bible-teacher?edit=noah-quiz&chat=c9")).toBe("/bible-teacher");
    expect(stripEditParams("/?edit=space-dodger&other=1")).toBe("/?other=1");
  });
});

describe("seed flow conversations", () => {
  it("EE.5 seeding placeholder is bound to the slug and shows progress, never a blank screen", () => {
    const c = seedingConversation("default", "space-dodger");
    expect(c.editSlug).toBe("space-dodger");
    expect(c.messages).toHaveLength(1);
    expect(c.messages[0]!.role).toBe("assistant");
    expect(c.messages[0]!.text).toBe(SEEDING_TEXT);
  });

  it("EE.6 bible-teacher entry keeps the workspace so the chat lands in the teacher recents", () => {
    expect(seedingConversation("bible-teacher", "noah-quiz").workspace).toBe("bible-teacher");
    expect(seedingConversation("default", "space-dodger").workspace).toBeUndefined();
  });

  it("EE.7 a successful seed titles the chat after the game and carries the playable code", () => {
    const seeded = applySeed(seedingConversation("default", "space-dodger"), {
      name: "Space Dodger",
      html: "<html><body>game</body></html>",
    });
    expect(seeded.title).toBe("Space Dodger");
    expect(seeded.editSlug).toBe("space-dodger");
    expect(seeded.messages[0]!.artifactHtml).toBe("<html><body>game</body></html>");
    expect(seeded.messages[0]!.text).toContain("Space Dodger");
    expect(seeded.messages[0]!.text).toContain("change");
  });

  it("EE.8 failures say what to do next — honest multi-file copy, no promises", () => {
    const base = seedingConversation("default", "castle-quest");
    const multi = applySeedFailure(base, { reason: "multi-file" });
    expect(multi.messages[0]!.text).toContain("many files");
    expect(multi.messages[0]!.text).toContain("re-upload");
    expect(multi.messages[0]!.text.toLowerCase()).not.toContain("coming");
    expect(multi.messages[0]!.artifactHtml).toBeUndefined();

    const signedOut = applySeedFailure(base, { signedOut: true });
    expect(signedOut.messages[0]!.text.toLowerCase()).toContain("sign in");

    const network = applySeedFailure(base, {});
    expect(network.messages[0]!.text.toLowerCase()).toContain("try");
    // A failed seed must not keep the binding — publishing from this chat
    // would otherwise overwrite a game we never loaded.
    expect(network.editSlug).toBeUndefined();
  });
});
