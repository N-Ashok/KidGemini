// Publish sheet step sequencing (BUG-FIX-LOG 2026-07-24): the sheet used to
// OPEN on "Name your game!" and only correct itself once the kid's game list
// came back — so a kid with existing games saw name → "What are we doing?" →
// (after choosing "brand-new") name again. It must not show a step it might
// have to take away.
import { describe, expect, it } from "vitest";
import { INITIAL_PUBLISH_STEP, stepAfterGamesLoad } from "./publish-flow";

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
