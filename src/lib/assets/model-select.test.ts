// Retrieval-lite selection tests (PRD §14 retrieval step, built 2026-07-13):
// the library grows unbounded, but any single prompt carries at most
// PROMPT_MODEL_CAP models — chosen from the kid's words, their history, and
// the models their existing game already uses. A wall of 50 names makes the
// model's choices WORSE, not better; selection is what makes 50+ scale.

import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { selectModelNames, CORE_MODELS, PROMPT_MODEL_CAP, GENRES } from "./model-select";
import { modelsInGenre } from "./asset-taxonomy";
import { ASSET_HOST_ORIGIN, type AssetManifest } from "./manifest";
import manifest from "./manifest.json";
import type { ChatMessage } from "@/types/chat.types";

const msg = (role: "child" | "assistant", text: string, artifactHtml?: string): ChatMessage =>
  ({ role, text, artifactHtml }) as ChatMessage;

const entry = (name: string) => ({
  name,
  type: "model" as const,
  url: `${ASSET_HOST_ORIGIN}/${name}.${"a".repeat(6)}.glb`,
  bytes: 20_000,
  license: "CC0" as const,
  sourceUrl: "https://example.com",
  sha256: "a".repeat(64),
});

// A big library (> cap) so selection actually has to choose.
const BIG_NAMES = [
  "car", "police", "firetruck", "taxi", "tractor", "coin", "star", "key", "chest", "tree",
  "rocket", "spaceship", "ufo", "helicopter", "alien", "dog", "cat", "fish", "bird", "dino",
  "tower", "ghost", "robot", "skyscraper", "house", "pine", "rock", "boat", "shark", "heart",
  "gem", "bomb", "flag", "mushroom", "barrel",
];
const big: AssetManifest = { assets: BIG_NAMES.map(entry) };

describe("selectModelNames — small libraries skip selection entirely", () => {
  it("a manifest at or under the cap returns every model (today's behavior, zero risk)", () => {
    const small: AssetManifest = { assets: BIG_NAMES.slice(0, 10).map(entry) };
    expect(selectModelNames({ message: "make me a game", history: [], manifest: small })).toEqual(BIG_NAMES.slice(0, 10));
  });
});

describe("selectModelNames — big library, genre keywords pick the subset", () => {
  it("a city ask gets city models, not sea creatures", () => {
    const picked = selectModelNames({ message: "make me a 3d city game", history: [], manifest: big });
    expect(picked).toContain("skyscraper");
    expect(picked).toContain("house");
    expect(picked).not.toContain("shark");
  });

  it("an underwater ask gets sea models, not buildings", () => {
    const picked = selectModelNames({ message: "a 3d game under the sea", history: [], manifest: big });
    expect(picked).toContain("shark");
    expect(picked).toContain("fish");
    expect(picked).not.toContain("skyscraper");
  });

  it("no genre match → the core set only (small, broadly useful)", () => {
    const picked = selectModelNames({ message: "3d something weird", history: [], manifest: big });
    expect(picked).toEqual(CORE_MODELS.filter((n) => BIG_NAMES.includes(n)));
  });
});

describe("selectModelNames — explicit names and iteration history always win", () => {
  it("naming a model directly includes it even with no genre word", () => {
    const picked = selectModelNames({ message: "3d ghost", history: [], manifest: big });
    expect(picked).toContain("ghost");
  });

  it("a model used by the game being iterated on is ALWAYS kept (artifact scan)", () => {
    const history = [
      msg("child", "3d city game"),
      msg("assistant", "Here's your game! 🎮", "<html><!--USES_THREE--><!--USES_MODELS: shark, dino--></html>"),
    ];
    const picked = selectModelNames({ message: "make the buildings taller", history, manifest: big });
    expect(picked).toContain("shark");
    expect(picked).toContain("dino");
    expect(picked).toContain("skyscraper"); // history text still carries "city"
  });

  it("keywords in earlier child messages still count", () => {
    const history = [msg("child", "i want a racing game"), msg("assistant", "ok!")];
    const picked = selectModelNames({ message: "with a dog driving", history, manifest: big });
    expect(picked).toContain("car");
    expect(picked).toContain("dog");
  });
});

describe("selectModelNames — the cap is a hard ceiling with sane priority", () => {
  it("never returns more than PROMPT_MODEL_CAP, whatever matches", () => {
    const everything = GENRES.map((g) => g.label).join(" ") + " racing city sea forest space castle sports food animals";
    const picked = selectModelNames({ message: `3d ${everything}`, history: [], manifest: big });
    expect(picked.length).toBeLessThanOrEqual(PROMPT_MODEL_CAP);
  });

  it("only ever returns names the manifest carries", () => {
    const picked = selectModelNames({ message: "3d city racing sea castle game", history: [], manifest: big });
    for (const name of picked) expect(BIG_NAMES).toContain(name);
  });
});

describe("selectModelNames — people / crowd genre (stadium humans, 2026-07-19)", () => {
  const PEOPLE = ["man", "woman", "girl", "scientist", "police_officer", "pirate"];
  const withPeople: AssetManifest = { assets: [...BIG_NAMES, ...PEOPLE, "grandstand"].map(entry) };

  it("a stadium-crowd ask picks people models and the grandstand, not sea creatures", () => {
    const picked = selectModelNames({ message: "a 3d stadium full of people cheering", history: [], manifest: withPeople });
    expect(picked).toContain("man");
    expect(picked).toContain("woman");
    expect(picked).toContain("girl");
    expect(picked).toContain("grandstand");
    expect(picked).not.toContain("shark");
  });

  it("'woman' / 'boy' style words trigger the people genre", () => {
    const picked = selectModelNames({ message: "3d game where a woman runs a race", history: [], manifest: withPeople });
    expect(picked).toContain("woman");
  });

  it("a city ask now includes people walking around", () => {
    const picked = selectModelNames({ message: "make me a 3d city game", history: [], manifest: withPeople });
    expect(picked).toContain("man");
    expect(picked).toContain("skyscraper");
  });

  it("a pirate ask surfaces the pirate person", () => {
    const picked = selectModelNames({ message: "a 3d pirate ship adventure", history: [], manifest: withPeople });
    expect(picked).toContain("pirate");
    expect(picked).toContain("boat");
  });

  it("no people words → no people models (selection stays tight)", () => {
    const picked = selectModelNames({ message: "3d game under the sea", history: [], manifest: withPeople });
    expect(picked).not.toContain("man");
    expect(picked).not.toContain("scientist");
  });
});

describe("GENRES — data sanity", () => {
  const allModels = new Set(
    (manifest as AssetManifest).assets.filter((a) => a.type === "model").map((a) => a.name),
  );

  it("every genre has a label, a trigger, and at least one member in the manifest", () => {
    for (const g of GENRES) {
      expect(g.label.length).toBeGreaterThan(0);
      expect(g.trigger.test("")).toBe(false);
      // Membership now lives on the assets (asset-taxonomy.ts). An empty genre
      // would render a heading with nothing under it.
      expect(modelsInGenre(g.id, allModels).length).toBeGreaterThan(0);
    }
  });

  it("every genre id is distinct (two genres sharing an id would double-render)", () => {
    const ids = GENRES.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
