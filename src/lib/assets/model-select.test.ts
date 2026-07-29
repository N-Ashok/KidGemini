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

describe("selectModelNames — sports genre (2026-07-26 batch)", () => {
  const SPORTS = ["soccer_ball", "soccer_goal", "footballer", "footballer_blue", "battle_top", "blade_top"];
  const withSports: AssetManifest = { assets: [...BIG_NAMES, ...SPORTS].map(entry) };

  it("a soccer ask picks the football set, not sea creatures", () => {
    const picked = selectModelNames({ message: "make me a 3d soccer game", history: [], manifest: withSports });
    expect(picked).toContain("soccer_ball");
    expect(picked).toContain("soccer_goal");
    expect(picked).toContain("footballer");
    expect(picked).not.toContain("shark");
  });

  it("'football' triggers the same set (the word kids actually use)", () => {
    const picked = selectModelNames({ message: "a 3d football match", history: [], manifest: withSports });
    expect(picked).toContain("soccer_ball");
    expect(picked).toContain("footballer_blue");
  });

  it("a beyblade ask surfaces the battle tops", () => {
    const picked = selectModelNames({ message: "3d beyblade battle arena", history: [], manifest: withSports });
    expect(picked).toContain("battle_top");
    expect(picked).toContain("blade_top");
  });

  it("'spinning top' works without the brand word", () => {
    const picked = selectModelNames({ message: "a 3d spinning top fight", history: [], manifest: withSports });
    expect(picked).toContain("battle_top");
  });

  it("no sports words → no sports models (selection stays tight)", () => {
    const picked = selectModelNames({ message: "3d game under the sea", history: [], manifest: withSports });
    expect(picked).not.toContain("soccer_ball");
    expect(picked).not.toContain("battle_top");
  });
});

describe("selectModelNames — military genre (2026-07-29 batch)", () => {
  const MILITARY = ["tank", "tank_desert", "tank_toy", "tank_rusty", "armored_truck", "turret", "sandbags", "bunker", "watchtower", "radar"];
  const withMilitary: AssetManifest = { assets: [...BIG_NAMES, ...MILITARY].map(entry) };

  it("a tank ask picks the tanks, not sea creatures", () => {
    const picked = selectModelNames({ message: "make me a 3d tank battle game", history: [], manifest: withMilitary });
    expect(picked).toContain("tank");
    expect(picked).toContain("tank_desert");
    expect(picked).not.toContain("shark");
  });

  it("'army' and 'soldier' words reach the set (kids say them for war games)", () => {
    const picked = selectModelNames({ message: "a 3d army game with soldiers", history: [], manifest: withMilitary });
    expect(picked).toContain("tank");
    expect(picked).toContain("bunker");
  });

  it("a base-defence ask surfaces the fortifications", () => {
    const picked = selectModelNames({ message: "3d game defending my base with turrets", history: [], manifest: withMilitary });
    expect(picked).toContain("turret");
    expect(picked).toContain("sandbags");
  });

  it("no military words → no military models (selection stays tight)", () => {
    const picked = selectModelNames({ message: "3d game under the sea", history: [], manifest: withMilitary });
    expect(picked).not.toContain("tank");
    expect(picked).not.toContain("turret");
  });
});

describe("selectModelNames — cricket (2026-07-29 batch)", () => {
  const CRICKET = ["cricket_bat", "cricket_ball", "wicket", "cricketer", "cricket_pitch"];
  const withCricket: AssetManifest = { assets: [...BIG_NAMES, ...CRICKET].map(entry) };

  it("a cricket ask picks the cricket set, not sea creatures", () => {
    const picked = selectModelNames({ message: "make me a 3d cricket game", history: [], manifest: withCricket });
    expect(picked).toContain("cricket_bat");
    expect(picked).toContain("cricket_ball");
    expect(picked).toContain("wicket");
    expect(picked).not.toContain("shark");
  });

  it("the words kids actually use reach it (batsman, bowler, stumps)", () => {
    for (const msg of ["a game with a batsman", "3d bowler game", "knock the stumps over"]) {
      expect(selectModelNames({ message: msg, history: [], manifest: withCricket })).toContain("cricket_bat");
    }
  });

  it("a non-sports ask pulls no cricket gear at all", () => {
    // NOTE the real granularity: cricket shares the `sports` GENRE with
    // football, so any sports word (kick, goal, match) legitimately pulls the
    // cricket set too — genres are the unit of selection, not individual
    // sports. An earlier version of this test asserted "run and kick a ball"
    // stays cricket-free; that was wrong about the design, not a bug. What DOES
    // matter is that a game with no sports words gets none of it.
    const picked = selectModelNames({ message: "3d game under the sea with a dragon", history: [], manifest: withCricket });
    expect(picked).not.toContain("wicket");
    expect(picked).not.toContain("cricket_bat");
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
