import { describe, it, expect } from "vitest";
import { CATEGORY_GUIDE, ALWAYS_HARD_BLOCK } from "./safety.config";

/** Policy decision 2026-07-06 (owner): classic game-genre content — shooters,
 *  sword adventures, cartoon battles — is allowed; the classifier must judge
 *  only REAL/graphic violence and REAL-WORLD dangerous acts. These tests lock
 *  the exemption wording so a future edit can't silently re-block game-making. */
describe("safety policy — game-action exemption", () => {
  it("violence category is scoped to graphic/realistic, exempting cartoon game action", () => {
    expect(CATEGORY_GUIDE.violence).toMatch(/graphic or realistic/i);
    expect(CATEGORY_GUIDE.violence).toMatch(/NOT violence/);
    expect(CATEGORY_GUIDE.violence).toMatch(/shooters/i);
  });

  it("dangerous_acts is scoped to the real world, exempting fictional game weapons", () => {
    expect(CATEGORY_GUIDE.dangerous_acts).toMatch(/REAL-WORLD/);
    expect(CATEGORY_GUIDE.dangerous_acts).toMatch(/NOT dangerous acts/);
  });

  it("the always-hard-block list is untouched by the exemption (fail-closed core)", () => {
    expect(ALWAYS_HARD_BLOCK).toEqual(["sexual", "self_harm", "stranger_contact"]);
  });
});
