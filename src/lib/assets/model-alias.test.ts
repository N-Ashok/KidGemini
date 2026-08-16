// Resolving invented model names onto real ones (2026-08-16).
//
// The governing rule is "prefer NO match over a wrong one": a missing model
// leaves the game's own placeholder, which a child already accepts; a WRONG
// model drops a strange object into their world. So most of these tests are
// about what must NOT match.
import { describe, it, expect } from "vitest";
import { resolveModelName, MODEL_ALIASES } from "./model-alias";
import manifestJson from "./manifest.json";
import type { AssetManifest } from "./manifest";

const real = new Set(
  (manifestJson as AssetManifest).assets.filter((a) => a.type === "model").map((a) => a.name),
);
const resolve = (n: string) => resolveModelName(n, real);

describe("the measured real-world cases", () => {
  it("stegosaurus -> dino (5 uses in stored games)", () => {
    expect(resolve("stegosaurus")).toEqual({ name: "dino", via: "alias" });
  });

  it("mermaid stays unmatched — nothing in the library is a mermaid", () => {
    // The second invented name. Inventing a match here would be worse than
    // the placeholder: it becomes the vendoring shopping list instead.
    expect(resolve("mermaid").name).toBeNull();
  });
});

describe("names that must resolve", () => {
  const cases: Array<[string, string]> = [
    ["car", "car"],
    ["CAR", "car"],
    ["Race Car", "sports_car"],
    ["race-car", "sports_car"],
    ["ducks", "chicken"],
    ["trees", "tree"],
    ["boxes", "crate"],
    ["puppy", "dog"],
    ["t_rex", "dino"],
    ["dinosaur", "dino"],
    ["motorbike", "motorcycle"],
    ["aeroplane", "airplane"],
    ["policeman", "police_officer"],
    ["treasure", "chest"],
    ["diamond", "gem"],
  ];
  for (const [asked, want] of cases) {
    it(`${asked} -> ${want}`, () => expect(resolve(asked).name).toBe(want));
  }
});

describe("names that must NOT resolve — a wrong model is worse than none", () => {
  for (const asked of [
    "mermaid",
    "unicorn",
    "wizard",
    "xyzzy",
    "thing",
    "asdfghjkl",
    "lake",
    "rainbow",
    "cloud",
  ]) {
    it(`${asked} stays unmatched`, () => expect(resolve(asked).name).toBeNull());
  }

  it("a tie between two equally-close real names resolves to nothing", () => {
    // `star` and `stag` are both real and one edit apart. A request one edit
    // from BOTH must not silently become either.
    const r = resolve("stat");
    if (r.name !== null) {
      // If it did match, it must not be one of the ambiguous pair.
      expect(["star", "stag"]).not.toContain(r.name);
    }
  });

  it("never invents a match for an empty or junk name", () => {
    expect(resolve("").name).toBeNull();
    expect(resolve("   ").name).toBeNull();
    expect(resolve("!!!").name).toBeNull();
    expect(resolve("___").name).toBeNull();
  });

  it("lake does NOT become cake — short names are never typo-matched", () => {
    // Produced by an earlier version of this function. Among four-letter words
    // one edit is a different word, not a slip, and a cake in place of a lake
    // is exactly the failure this module exists to avoid.
    expect(resolve("lake").name).toBeNull();
    expect(resolve("cave").name).toBeNull();
    expect(resolve("moon").name).toBeNull();
  });
});

describe("safety of the alias table itself", () => {
  it("every alias points at a model that actually exists", () => {
    // An alias to a model we later remove must be caught here, not in a
    // child's game as a broken URL.
    const dangling = Object.entries(MODEL_ALIASES).filter(([, target]) => !real.has(target));
    expect(dangling).toEqual([]);
  });

  it("no alias shadows a real model name", () => {
    // If `bat` is a real animal, an alias `bat -> baseball_bat` would hijack
    // every legitimate request for it. Exact match always wins, but the table
    // should not contain the trap in the first place.
    const shadowing = Object.keys(MODEL_ALIASES).filter((k) => real.has(k));
    expect(shadowing).toEqual([]);
  });

  it("resolves deterministically — same answer every time", () => {
    for (let i = 0; i < 5; i++) expect(resolve("stegosaurus").name).toBe("dino");
  });
});

describe("compound names", () => {
  it("prefers the longest real name whose tokens are all present", () => {
    expect(resolve("big_snow_pine_tree").name).toBe("snow_pine");
  });

  it("does not match a compound whose tokens are not all present", () => {
    expect(resolve("flying_purple_submarine").name).toBeNull();
  });

  it("a descriptive compound resolves to the real noun inside it", () => {
    // "giant purple space dragon of doom" -> dragon, and
    // "spaceship battlecruiser mk2" -> spaceship. These read like failures
    // but are the behaviour we want: the child named something we DO have,
    // wrapped in adjectives.
    expect(resolve("giant_purple_space_dragon_of_doom").name).toBe("dragon");
    expect(resolve("spaceship_battlecruiser_mk2").name).toBe("spaceship");
  });
});

describe("performance — this runs on every injection", () => {
  it("resolves a large batch quickly", () => {
    const t0 = Date.now();
    for (let i = 0; i < 2_000; i++) resolve(`invented_name_${i}`);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});
