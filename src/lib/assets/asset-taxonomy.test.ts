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
  // Born after the migration (2026-07-26 sports batch) — nothing to preserve.
  sports: [],
  // Likewise the 2026-07-29 military batch.
  military: [],
  // Born after the migration (2026-07-30 indian games batch) — nothing to preserve.
  indian_games: [],
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
  it("is the 18 kit characters plus the 5 sports/indian-games re-skins — every one shares the clip list", () => {
    // The footballers (2026-07-26) and the cricketer (2026-07-29) are
    // re-textured character-b meshes — same skeleton, same clips, only the
    // atlas is re-painted — so listing them here keeps the people-clips prompt
    // line true. 20 → 21 with the cricket batch; 21 → 23 with the indian
    // games batch (2026-07-30): kabaddi_player + kho_kho_player are the same
    // re-skin technique, sharing one new "kabaddi" kit (PRD §2.1/§2.3).
    expect([...modelsWithRig("kenney_blocky", new Set(modelNames))].sort()).toEqual([
      "businessman", "cricketer", "explorer", "footballer", "footballer_blue", "gamer", "girl",
      "grandpa", "kabaddi_player", "kho_kho_player", "kimono_woman", "man", "mascot", "mech",
      "ninja", "orc", "pirate", "plumber", "police_officer", "purple_mech", "scientist", "woman",
      "zombie",
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

// Sports batch (2026-07-26, docs/2026-07-26_PRD_SportsAssets.md): first-party
// CC0 models + two Kenney-derivative footballers. Pinned by name so a pipeline
// or curation edit can't silently drop the set the sports trigger promises.
describe("sports genre (2026-07-26 batch)", () => {
  const SPORTS_MODELS = ["soccer_ball", "soccer_goal", "footballer", "footballer_blue", "battle_top", "blade_top"];

  it("the manifest carries all six sports models", () => {
    for (const name of SPORTS_MODELS) expect(modelNames).toContain(name);
  });

  it("all six sit in the sports genre", () => {
    const members = modelsInGenre("sports", new Set(modelNames));
    for (const name of SPORTS_MODELS) expect(members).toContain(name);
  });

  it("the battle tops do NOT claim the character rig (a top has no walk clip)", () => {
    const rigged = modelsWithRig("kenney_blocky", new Set(modelNames));
    expect(rigged).not.toContain("battle_top");
    expect(rigged).not.toContain("blade_top");
  });

  it("kid vocabulary reaches the models via tags (beyblade → battle_top, keeper → footballer)", () => {
    expect(tagsOf("battle_top")).toContain("beyblade");
    expect(tagsOf("soccer_ball")).toContain("football");
  });
});

// Military batch (2026-07-29, docs/2026-07-29_PRD_MilitaryAssets.md). Pinned by
// name for the same reason as the sports set, PLUS a scope guard: the batch is
// deliberately vehicles + fortifications ONLY (owner decision), so the tests
// below also assert that no soldier character or hand-held weapon crept in on a
// later pass.
describe("military genre (2026-07-29 batch)", () => {
  const MILITARY_MODELS = [
    "tank", "tank_desert", "tank_toy", "tank_rusty",
    "armored_truck", "armored_pickup",
    "turret", "turret_cannon", "cannon",
    "sandbags", "sandbags_small", "barricade",
    "bunker", "watchtower", "radar", "chain_fence",
  ];

  it("the manifest carries every military model", () => {
    for (const name of MILITARY_MODELS) expect(modelNames).toContain(name);
  });

  it("all of them sit in the military genre", () => {
    const members = modelsInGenre("military", new Set(modelNames));
    for (const name of MILITARY_MODELS) expect(members).toContain(name);
  });

  it("ships four visibly distinct tanks so a battle has two SIDES", () => {
    const tanks = modelNames.filter((n) => n.startsWith("tank"));
    expect(tanks.length).toBeGreaterThanOrEqual(4);
  });

  it("none of them claims the character rig (a tank has no walk clip)", () => {
    const rigged = modelsWithRig("kenney_blocky", new Set(modelNames));
    for (const name of MILITARY_MODELS) expect(rigged).not.toContain(name);
  });

  // Batch 2 (2026-07-29, same day): the owner reversed batch 1's
  // vehicles-and-fortifications-only scope — "let there be soldiers, hand held
  // weapons and grenade launchers … it is all part of kids games these days".
  // The batch-1 scope-guard test that BANNED these names was deleted with that
  // decision; this describe replaces it and pins the set that shipped instead.
  it("carries the soldiers and the hand-held weapons (owner decision, 2026-07-29)", () => {
    for (const name of ["soldier", "hazmat", "rifle", "assault_rifle", "sniper_rifle", "shotgun",
      "pistol", "revolver", "submachine_gun", "rocket_launcher", "grenade_launcher", "bazooka",
      "grenade", "landmine", "flare_gun", "laser_gun", "space_rifle", "space_pistol",
      "bullets", "shield"]) {
      expect(modelNames).toContain(name);
    }
  });

  it("the soldiers carry their OWN rig, never the Kenney people rig", () => {
    // Different skeleton, different clip names (Run_Gun/Idle_Shoot vs
    // sprint/emote-yes). Cross-listing them would make the prompt promise
    // clips that do not exist — the exact failure the rig split prevents.
    const soldiers = modelsWithRig("quaternius_soldier", new Set(modelNames));
    expect(soldiers).toEqual(expect.arrayContaining(["soldier", "hazmat"]));
    const kenney = modelsWithRig("kenney_blocky", new Set(modelNames));
    expect(kenney).not.toContain("soldier");
    expect(kenney).not.toContain("hazmat");
  });

  it("the weapons are inert props — no rig, so no clip is ever promised", () => {
    for (const weapon of ["rifle", "bazooka", "grenade", "shield"]) {
      expect(TAXONOMY[weapon]?.rig).toBeUndefined();
    }
  });

  it("kid vocabulary reaches the models via tags (army → tank, sandbag → sandbags)", () => {
    expect(tagsOf("tank")).toContain("army");
    expect(tagsOf("sandbags")).toContain("sandbag");
    expect(tagsOf("watchtower")).toContain("lookout");
  });
});

// Cricket batch (2026-07-29, docs/2026-07-29_PRD_CricketAssets.md). FIRST-PARTY:
// the free 3D pool has no cricket at all (zero CC0, two CC-BY bats and nothing
// else), so these are authored in-repo. Pinned by name so a pipeline or curation
// edit cannot silently drop the set the cricket trigger promises.
describe("cricket set (2026-07-29 batch)", () => {
  const CRICKET = ["cricket_bat", "cricket_ball", "wicket", "cricket_pitch", "sight_screen", "cricketer", "trophy"];

  it("the manifest carries the whole cricket set", () => {
    for (const name of CRICKET) expect(modelNames).toContain(name);
  });

  it("all of it sits in the sports genre", () => {
    const members = modelsInGenre("sports", new Set(modelNames));
    for (const name of CRICKET) expect(members).toContain(name);
  });

  it("the cricketer carries the Kenney rig (a re-skin, so the clip promise is real)", () => {
    // Same argument as the footballers: mesh and rig untouched, only the atlas
    // is re-painted, so every blocky-character clip genuinely exists on it.
    expect(modelsWithRig("kenney_blocky", new Set(modelNames))).toContain("cricketer");
  });

  it("the equipment does NOT claim the rig (a bat has no walk clip)", () => {
    const rigged = modelsWithRig("kenney_blocky", new Set(modelNames));
    for (const gear of ["cricket_bat", "cricket_ball", "wicket", "cricket_pitch", "sight_screen"]) {
      expect(rigged).not.toContain(gear);
    }
  });

  it("kid vocabulary reaches the set via tags (stumps → wicket, batsman → cricketer)", () => {
    expect(tagsOf("wicket")).toContain("stumps");
    expect(tagsOf("cricketer")).toContain("batsman");
    expect(tagsOf("cricket_bat")).toContain("bat");
  });
});

// Indian games batch (2026-07-30, docs/2026-07-30_PRD_IndianGamesAssets.md) —
// kabaddi, carrom, kho-kho, badminton, ludo, marbles. FIRST-PARTY: a
// poly.pizza/Kenney/Quaternius sweep (2026-07-30) found zero usable CC0 models
// for any of the six. New genre "indian_games" (kept separate from `sports` —
// carrom/ludo/marbles are tabletop games, not sports in the cricket/football
// sense). Pinned by name for the same reason as every prior batch.
describe("indian games set (2026-07-30 batch)", () => {
  const INDIAN_GAMES = [
    "kabaddi_mat", "kabaddi_player",
    "carrom_board", "carrom_striker", "carrom_coin_white", "carrom_coin_black", "carrom_queen",
    "kho_kho_pole", "kho_kho_lane_field", "kho_kho_player",
    "badminton_racket", "shuttlecock", "badminton_net",
    "ludo_board", "ludo_dice", "ludo_pawn_red", "ludo_pawn_green", "ludo_pawn_yellow", "ludo_pawn_blue",
    "marble", "marble_blue", "marble_green",
  ];

  it("the manifest carries every indian-games model", () => {
    for (const name of INDIAN_GAMES) expect(modelNames).toContain(name);
  });

  it("all of them sit in the new indian_games genre", () => {
    const members = modelsInGenre("indian_games", new Set(modelNames));
    for (const name of INDIAN_GAMES) expect(members).toContain(name);
  });

  it("kabaddi_player and kho_kho_player carry the Kenney rig (re-skins, so the clip promise is real)", () => {
    const rigged = modelsWithRig("kenney_blocky", new Set(modelNames));
    expect(rigged).toContain("kabaddi_player");
    expect(rigged).toContain("kho_kho_player");
  });

  it("the equipment/board/piece models do NOT claim the rig (a board has no walk clip)", () => {
    const rigged = modelsWithRig("kenney_blocky", new Set(modelNames));
    for (const gear of [
      "kabaddi_mat", "carrom_board", "carrom_striker", "carrom_coin_white", "carrom_coin_black",
      "carrom_queen", "kho_kho_pole", "kho_kho_lane_field", "badminton_racket", "shuttlecock",
      "badminton_net", "ludo_board", "ludo_dice", "ludo_pawn_red", "ludo_pawn_green",
      "ludo_pawn_yellow", "ludo_pawn_blue", "marble", "marble_blue", "marble_green",
    ]) {
      expect(rigged).not.toContain(gear);
    }
  });

  it("the coin/pawn/marble colour variants each resolve to a distinct manifest name", () => {
    const names = new Set(INDIAN_GAMES);
    expect(names.has("carrom_coin_white")).toBe(true);
    expect(names.has("carrom_coin_black")).toBe(true);
    expect(names.size).toBe(INDIAN_GAMES.length); // no accidental duplicate name
  });

  it("kid vocabulary reaches the set via tags (goli → marble, khokho → kho_kho_player)", () => {
    expect(tagsOf("marble")).toContain("goli");
    expect(tagsOf("kho_kho_player")).toContain("khokho");
    expect(tagsOf("kabaddi_player")).toContain("kabaddi");
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
