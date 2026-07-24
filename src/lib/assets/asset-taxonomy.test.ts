// Contract tests for the curation layer (2026-07-24). The taxonomy is what lets
// a ~300-model library stay navigable: it groups the prompt catalog into
// categories and gives the gallery its search vocabulary. Two things are
// attacked here — that it stays in step with the manifest (a model with no
// taxonomy entry would silently vanish from every category heading), and that
// migrating genre membership off model-select.ts changed NOTHING for the 106
// models that already existed.

import { describe, it, expect } from "vitest";
import {
  GENRE_IDS,
  TAXONOMY,
  genresOf,
  tagsOf,
  modelsInGenre,
  modelsWithRig,
  validateTaxonomy,
  type GenreId,
} from "./asset-taxonomy";
import manifest from "./manifest.json";
import type { AssetManifest } from "./manifest";

const modelNames = (manifest as AssetManifest).assets.filter((a) => a.type === "model").map((a) => a.name);

describe("the taxonomy covers the manifest", () => {
  it("has an entry for every model — a missing one would drop out of every category heading", () => {
    const missing = modelNames.filter((n) => !TAXONOMY[n]);
    expect(missing).toEqual([]);
  });

  it("has no entry for a model that does not exist (stale curation is a silent lie)", () => {
    const known = new Set(modelNames);
    expect(Object.keys(TAXONOMY).filter((n) => !known.has(n))).toEqual([]);
  });

  it("gives every model at least one genre — an ungrouped model is unreachable in the catalog", () => {
    expect(modelNames.filter((n) => genresOf(n).length === 0)).toEqual([]);
  });

  it("passes its own validator against the real manifest (standing commit gate)", () => {
    expect(() => validateTaxonomy(modelNames)).not.toThrow();
  });
});

describe("validateTaxonomy — fails closed on malformed curation", () => {
  it("rejects a tag that is not lowercase-snake (tags are matched against a kid's raw words)", () => {
    expect(() => validateTaxonomy(["x"], { x: { genres: ["city"], tags: ["Fire Truck"] } })).toThrow(/tag/i);
    expect(() => validateTaxonomy(["x"], { x: { genres: ["city"], tags: [""] } })).toThrow(/tag/i);
  });

  it("rejects duplicate tags on one asset (a repeat would double-count in scoring)", () => {
    expect(() => validateTaxonomy(["x"], { x: { genres: ["city"], tags: ["siren", "siren"] } })).toThrow(
      /duplicate/i,
    );
  });

  it("rejects an unknown genre id", () => {
    expect(() => validateTaxonomy(["x"], { x: { genres: ["nope" as GenreId], tags: [] } })).toThrow(/genre/i);
  });

  it("rejects a model with no genres at all", () => {
    expect(() => validateTaxonomy(["x"], { x: { genres: [], tags: [] } })).toThrow(/genre/i);
  });

  it("rejects a manifest model that has no taxonomy entry", () => {
    expect(() => validateTaxonomy(["x", "y"], { x: { genres: ["city"], tags: [] } })).toThrow(/y/);
  });
});

// The migration proof. These arrays are copied verbatim from the GENRES literal
// in model-select.ts as it stood BEFORE membership moved onto the assets
// (2026-07-24). If deriving membership from the taxonomy reproduces them
// exactly, the move is behaviour-preserving and the prompt cannot have shifted.
const GENRE_MEMBERSHIP_BEFORE_MIGRATION: Record<GenreId, string[]> = {
  people: ["man", "woman", "girl", "scientist", "police_officer", "pirate", "grandstand"],
  racing: [
    "car", "police", "firetruck", "taxi", "ambulance", "tractor", "coin",
    "garbage_truck", "pickup_truck", "gokart",
    "race_track_straight", "race_track_curve", "finish_line", "checkered_flag", "grandstand", "pit_garage",
  ],
  platformer: [
    "hero", "coin", "star", "key", "chest", "heart", "gem", "spring", "crate", "barrel", "bomb", "flag",
    "tree", "mushroom", "lock", "lever", "saw", "signpost", "ladder",
  ],
  space: ["rocket", "spaceship", "ufo", "helicopter", "alien", "star"],
  animals: ["dog", "cat", "fish", "bird", "chicken", "bee", "dino"],
  castle: [
    "hero", "tower", "key", "chest", "sword", "catapult", "bridge", "ghost", "bat", "dino", "robot", "gem",
    "ballista", "trebuchet", "battering_ram", "castle_gate", "drawbridge", "siege_tower", "castle_door",
    "dragon", "dragon_evolved", "pirate",
  ],
  city: [
    "skyscraper", "house", "car", "police", "firetruck", "helicopter",
    "office_building", "apartment", "shop", "driveway", "planter", "garbage_truck",
    "man", "woman", "girl", "police_officer",
  ],
  nature: [
    "pine", "tree", "rock", "bird", "mushroom", "dog",
    "cactus", "campfire", "canoe", "tent", "palm_tree", "statue", "toadstool",
  ],
  water: ["boat", "fish", "shark", "dolphin", "chest", "canoe", "pirate"],
  food: [
    "burger", "ice_cream", "donut", "apple", "chicken",
    "pizza", "hotdog", "banana", "watermelon", "cake", "cupcake", "taco", "carrot",
    "strawberry", "sandwich", "corn", "sushi", "egg", "muffin", "cherries",
  ],
};

describe("migrating genre membership onto the assets never DROPS a model", () => {
  // Originally an equality check (it proved the 2026-07-24 migration was a
  // no-op). Now that we deliberately add models, equality would break on every
  // import and get "fixed" by pasting in the new list — which would silently
  // stop protecting anything. Subset keeps the real guarantee: a curation edit
  // can add members to a genre, but can never quietly remove one that games in
  // the wild already reference.
  it.each(GENRE_IDS)("genre %s still contains every member it had before the migration", (genre) => {
    const before = GENRE_MEMBERSHIP_BEFORE_MIGRATION[genre];
    const after = new Set(modelsInGenre(genre, new Set(modelNames)));
    const dropped = before.filter((n) => !after.has(n));
    expect(dropped).toEqual([]);
  });
});

// Regression-locked. The people-clips prompt line promises "idle, walk, sprint,
// sit, drive…" for every name it lists. The `people` GENRE contains grandstand —
// a stadium — so deriving that line from the genre would tell the model a
// grandstand can walk. Rig, not genre, is the only valid source.
describe("shared-rig set is exactly the Kenney Blocky characters", () => {
  it("is all 18 of them — the whole kit is imported and every one shares the clip list", () => {
    expect([...modelsWithRig("kenney_blocky", new Set(modelNames))].sort()).toEqual([
      "businessman", "explorer", "gamer", "girl", "grandpa", "kimono_woman", "man", "mascot",
      "mech", "ninja", "orc", "pirate", "plumber", "police_officer", "purple_mech", "scientist",
      "woman", "zombie",
    ]);
  });

  it("excludes grandstand even though it sits in the people genre", () => {
    expect(modelsInGenre("people", new Set(modelNames))).toContain("grandstand");
    expect(modelsWithRig("kenney_blocky", new Set(modelNames))).not.toContain("grandstand");
  });

  it("never lists a non-character as sharing the character rig", () => {
    // The rig set drives a prompt line promising idle/walk/sprint/sit clips.
    // Anything in here that is not a Kenney Blocky humanoid is a lie the model
    // will act on, so this asserts the whole set against a scenery blocklist.
    const rigged = modelsWithRig("kenney_blocky", new Set(modelNames));
    for (const scenery of ["grandstand", "house", "car", "tree", "pit_garage"]) {
      expect(rigged).not.toContain(scenery);
    }
  });
});

describe("lookup helpers are total (never throw on an unknown name)", () => {
  it("returns empty for a model with no taxonomy entry rather than exploding mid-prompt", () => {
    expect(genresOf("no_such_model")).toEqual([]);
    expect(tagsOf("no_such_model")).toEqual([]);
  });

  it("filters modelsInGenre to what is actually available", () => {
    expect(modelsInGenre("food", new Set(["pizza"]))).toEqual(["pizza"]);
  });
});
