// PRD-SPARKS closure §4 — the chat celebration card after a publish: pick
// the publish reward for THIS game out of the kid-safe wallet credits feed.
import { describe, it, expect, vi } from "vitest";
import { publishCelebration, slugFromLiveUrl, fetchPublishCelebration } from "./publish-celebration";

const row = (over: Partial<{ kind: string; amount: number; gameSlug?: string }> = {}) => ({
  kind: "publish_reward",
  amount: 500,
  gameSlug: "shark-racer",
  ...over,
});

describe("slugFromLiveUrl", () => {
  it("extracts the slug from a live game URL", () => {
    expect(slugFromLiveUrl("https://shark-racer.ariantra.com/")).toBe("shark-racer");
    expect(slugFromLiveUrl("https://shark-racer.ariantra.com")).toBe("shark-racer");
  });
  it("returns null for junk/non-game hosts", () => {
    expect(slugFromLiveUrl("")).toBeNull();
    expect(slugFromLiveUrl("not a url")).toBeNull();
    expect(slugFromLiveUrl("https://games.ariantra.com/")).toBeNull(); // reserved label, not a game
  });
});

describe("publishCelebration", () => {
  it("finds the publish reward for this slug", () => {
    const earned = [row({ kind: "coupon", gameSlug: undefined }), row()];
    expect(publishCelebration(earned, "shark-racer")).toEqual({ amount: 500 });
  });

  it("ignores rewards for OTHER games and non-publish kinds", () => {
    expect(publishCelebration([row({ gameSlug: "other-game" })], "shark-racer")).toBeNull();
    expect(publishCelebration([row({ kind: "invite_reward" })], "shark-racer")).toBeNull();
  });

  it("null on empty/missing feed, missing slug, or a zero-⚡ reward (republish)", () => {
    expect(publishCelebration(undefined, "shark-racer")).toBeNull();
    expect(publishCelebration([], "shark-racer")).toBeNull();
    expect(publishCelebration([row()], null)).toBeNull();
    expect(publishCelebration([row({ amount: 0 })], "shark-racer")).toBeNull();
  });
});

describe("fetchPublishCelebration — the whole done-screen glue, injectable fetch", () => {
  const ok = (body: unknown) =>
    vi.fn(async () => ({ ok: true, json: async () => body }) as unknown as Response);

  it("fetches /api/wallet and picks this game's publish reward", async () => {
    const fetchImpl = ok({ earned: [row()] });
    await expect(fetchPublishCelebration("https://shark-racer.ariantra.com/", fetchImpl)).resolves.toEqual({ amount: 500 });
    expect(fetchImpl).toHaveBeenCalledWith("/api/wallet");
  });

  it("null (never a rejection) on HTTP error, network failure, or junk JSON", async () => {
    await expect(
      fetchPublishCelebration("https://shark-racer.ariantra.com/", vi.fn(async () => ({ ok: false }) as Response)),
    ).resolves.toBeNull();
    await expect(
      fetchPublishCelebration("https://shark-racer.ariantra.com/", vi.fn(async () => { throw new Error("offline"); })),
    ).resolves.toBeNull();
    await expect(
      fetchPublishCelebration(
        "https://shark-racer.ariantra.com/",
        vi.fn(async () => ({ ok: true, json: async () => { throw new Error("bad json"); } }) as unknown as Response),
      ),
    ).resolves.toBeNull();
  });

  it("null for a non-game live URL (surface hosts never celebrate)", async () => {
    await expect(fetchPublishCelebration("https://games.ariantra.com/", ok({ earned: [row()] }))).resolves.toBeNull();
  });
});
