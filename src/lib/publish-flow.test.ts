// Publish sheet step sequencing (BUG-FIX-LOG 2026-07-24): the sheet used to
// OPEN on "Name your game!" and only correct itself once the kid's game list
// came back — so a kid with existing games saw name → "What are we doing?" →
// (after choosing "brand-new") name again. It must not show a step it might
// have to take away.
import { describe, expect, it } from "vitest";
import { INITIAL_PUBLISH_STEP, publishBlockReason, stepAfterGamesLoad } from "./publish-flow";

describe("INITIAL_PUBLISH_STEP", () => {
  it("opens on the loading step — never a guess at name/choose", () => {
    expect(INITIAL_PUBLISH_STEP).toBe("loading");
  });
});

describe("stepAfterGamesLoad", () => {
  it("routes a kid who already has games to the choose step", () => {
    expect(stepAfterGamesLoad({ current: "loading", gameCount: 2 })).toBe("choose");
  });

  it("routes a kid with no games straight to naming — no pointless question", () => {
    expect(stepAfterGamesLoad({ current: "loading", gameCount: 0 })).toBe("name");
  });

  it("recovers from the signin step the same way once auth lands", () => {
    // signIn() round-trips back to this page; the sheet reopens signed in.
    expect(stepAfterGamesLoad({ current: "signin", gameCount: 3 })).toBe("choose");
    expect(stepAfterGamesLoad({ current: "signin", gameCount: 0 })).toBe("name");
  });

  it("never yanks a kid off a step they're already working on", () => {
    // The list fetch can resolve (or a retry can re-resolve) at any time — it
    // must not pull someone out of naming, the PIN, or a running publish.
    for (const current of ["name", "pick", "pin", "publishing", "done"] as const) {
      expect(stepAfterGamesLoad({ current, gameCount: 5 })).toBe(current);
    }
  });

  it("a failed list load still leaves a usable flow (treated as no games)", () => {
    // The name step shows its own retry affordance — better than trapping the
    // kid on a spinner they can't leave.
    expect(stepAfterGamesLoad({ current: "loading", gameCount: 0 })).toBe("name");
  });

  it("an edit chat's preset target skips choose/pick — the game to update is already known", () => {
    // Edit-a-launched-game (PRD-STUDIO-CHAT-EDIT rev 2026-07-24): a chat bound
    // to a published slug goes straight to the confirm/name step as an update,
    // no matter how many other games the kid has.
    expect(stepAfterGamesLoad({ current: "loading", gameCount: 5, hasPresetTarget: true })).toBe("name");
    expect(stepAfterGamesLoad({ current: "signin", gameCount: 5, hasPresetTarget: true })).toBe("name");
  });
});

// ── Why is "Next" greyed out? (owner report 2026-08-17: "use a different url
// in the publish don't work") ──────────────────────────────────────────────
// Ticking "Use a different web address" swapped the slug source from the game
// NAME to an empty custom field, so the button greyed out instantly and said
// nothing about why. Worse, nameToSlug() returns "" for anything under two
// usable characters, so typing "a" or "!!" ALSO produced a dead button while
// the hint underneath cheerfully read "Your game will live at .ariantra.com".
//
// The button's disabled-ness and the sentence explaining it now come from the
// same function, so they can't disagree.
describe("publishBlockReason — a greyed-out button always says why", () => {
  const ok = { name: "Dragon Flyer", category: "Adventure", check: "free" as const };

  it("P.1 nothing blocking → no reason, and the button is live", () => {
    expect(publishBlockReason({ ...ok })).toBeNull();
  });

  it("P.2 no name yet → asks for one", () => {
    expect(publishBlockReason({ ...ok, name: "" })).toMatch(/name/i);
  });

  it("P.3 custom address ticked but empty → asks for the ADDRESS, not the name", () => {
    // The old code just disabled the button: the kid had ticked a box and the
    // Next button died, with the name field still full.
    const reason = publishBlockReason({ ...ok, useCustomSlug: true, customSlug: "" });
    expect(reason).toBeTruthy();
    expect(reason).toMatch(/address/i);
  });

  it("P.4 a custom address too short to become a slug says so", () => {
    // nameToSlug("a") === "" — one character, and every symbol-only string,
    // silently produces nothing.
    for (const tooShort of ["a", "!", "-", "!!"]) {
      const reason = publishBlockReason({ ...ok, useCustomSlug: true, customSlug: tooShort });
      expect(reason, `"${tooShort}" should be rejected with a reason`).toBeTruthy();
      expect(reason).toMatch(/address/i);
    }
  });

  it("P.5 a usable custom address unblocks it — the name no longer matters", () => {
    expect(publishBlockReason({ ...ok, name: "", useCustomSlug: true, customSlug: "my-cool-game" })).toBeNull();
  });

  it("P.6 no category picked → asks for the kind of game", () => {
    expect(publishBlockReason({ ...ok, category: null })).toMatch(/kind of game/i);
  });

  it("P.7 a bible game needs no category", () => {
    expect(publishBlockReason({ ...ok, category: null, bibleGame: true })).toBeNull();
  });

  it("P.8 a taken or trademarked name blocks, and says which", () => {
    expect(publishBlockReason({ ...ok, check: "taken" })).toMatch(/another name/i);
    expect(publishBlockReason({ ...ok, check: "copyright" })).toMatch(/your own/i);
  });

  it("P.9 an UPDATE needs neither a name nor a category — the game already has both", () => {
    expect(publishBlockReason({ name: "", category: null, check: "idle", isUpdate: true })).toBeNull();
  });

  it("P.10 a check that could not run never blocks — publish re-validates server-side", () => {
    expect(publishBlockReason({ ...ok, check: "unknown" })).toBeNull();
    expect(publishBlockReason({ ...ok, check: "checking" })).toBeNull();
  });
});
