// "Game Stuff" gallery data (PRD-3D-GAMES-AND-ASSETS §9b): the kid-facing
// view of the asset library, rendered straight from the in-repo manifest —
// zero backend, zero new data. Each card teaches the trigger phrase that
// unlocks the asset in chat (the free tier's keyword tutorial, §9c). A new
// manifest entry becomes a new card with no page work. Pure data, no I/O.

import type { AssetManifest } from "./manifest";
import manifestJson from "./manifest.json";

export interface GalleryCard {
  name: string;
  /** Kid-readable: underscores → spaces, first letter capitalized. */
  displayName: string;
  type: "model" | "sfx" | "music";
  url: string;
  /** The phrase the card teaches — saying it in chat unlocks the asset. */
  trigger: string;
}

const EMOJI: Record<string, string> = {
  car: "🚗",
  dino: "🦖",
  tree: "🌳",
  coin: "🪙",
  rocket: "🚀",
  airplane: "✈️",
  boat: "⛵",
  dog: "🐶",
  cat: "🐱",
  fish: "🐠",
  robot: "🤖",
  tower: "🏰",
  spaceship: "🛸",
  ufo: "👽",
  helicopter: "🚁",
  ghost: "👻",
  police: "🚓",
  firetruck: "🚒",
  star: "⭐",
  key: "🗝️",
  chest: "💰",
  skyscraper: "🏙️",
  house: "🏠",
  pine: "🌲",
  rock: "🪨",
  alien: "👾",
  bird: "🐦",
  shark: "🦈",
  hero: "🦸",
  heart: "❤️",
  gem: "💎",
  bomb: "💣",
  spring: "🪀",
  flag: "🚩",
  mushroom: "🍄",
  barrel: "🛢️",
  crate: "📦",
  taxi: "🚕",
  ambulance: "🚑",
  tractor: "🚜",
  catapult: "🏹",
  bridge: "🌉",
  burger: "🍔",
  ice_cream: "🍦",
  donut: "🍩",
  apple: "🍎",
  chicken: "🐔",
  bat: "🦇",
  dolphin: "🐬",
  bee: "🐝",
  sword: "🗡️",

  // Fill to 100 (2026-07-14, owner request: city models, race tracks, dragons).
  garbage_truck: "🚛",
  pickup_truck: "🛻",
  gokart: "🏎️",
  ballista: "🏹",
  trebuchet: "🏹",
  battering_ram: "🐏",
  castle_gate: "🚪",
  drawbridge: "🌉",
  siege_tower: "🏯",
  castle_door: "🚪",
  lock: "🔒",
  lever: "🎚️",
  saw: "🪚",
  signpost: "🪧",
  ladder: "🪜",
  pizza: "🍕",
  hotdog: "🌭",
  banana: "🍌",
  watermelon: "🍉",
  cake: "🎂",
  cupcake: "🧁",
  taco: "🌮",
  carrot: "🥕",
  strawberry: "🍓",
  sandwich: "🥪",
  corn: "🌽",
  sushi: "🍣",
  egg: "🥚",
  muffin: "🍰",
  cherries: "🍒",
  cactus: "🌵",
  campfire: "🔥",
  canoe: "🛶",
  tent: "⛺",
  palm_tree: "🌴",
  statue: "🗿",
  toadstool: "🍄",
  office_building: "🏢",
  shop: "🏪",
  apartment: "🏘️",
  driveway: "🛣️",
  planter: "🪴",
  race_track_straight: "🛣️",
  race_track_curve: "🛣️",
  finish_line: "🏁",
  checkered_flag: "🏁",
  grandstand: "🏟️",
  pit_garage: "🔧",
  dragon: "🐉",
  dragon_evolved: "🐲",

  // People (2026-07-19: stadium humans — Kenney Blocky Characters).
  man: "🧍",
  woman: "🧍‍♀️",
  girl: "👧",
  scientist: "🧑‍🔬",
  police_officer: "👮",
  pirate: "🏴‍☠️",
};

/** Every card gets a face — unknown names fall back to the toy box. */
export function cardEmoji(name: string): string {
  return EMOJI[name] ?? "🧸";
}

function displayName(name: string): string {
  const spaced = name.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// Keyed by the display form (underscores already → spaces).
const IRREGULAR_PLURALS: Record<string, string> = {
  fish: "fish",
  police: "police",
  hero: "heroes",
  "ice cream": "ice cream",
  man: "men",
  woman: "women",
};

function plural(name: string): string {
  return IRREGULAR_PLURALS[name] ?? `${name}s`;
}

export function galleryCards(manifest: AssetManifest = manifestJson as AssetManifest): {
  models: GalleryCard[];
  sounds: GalleryCard[];
} {
  const models: GalleryCard[] = [];
  const sounds: GalleryCard[] = [];
  for (const a of manifest.assets) {
    if (a.type === "model") {
      models.push({
        name: a.name,
        displayName: displayName(a.name),
        type: a.type,
        url: a.url,
        // Short magic words (owner decision 2026-07-12): just "3d cars" —
        // carries the "3d" free-tier trigger (§9) + the model's name. The
        // chat's build-turn gate treats a bare "3d …" phrase as a game ask.
        trigger: `3d ${plural(a.name.replace(/_/g, " "))}`,
      });
    } else if (a.type === "sfx" || a.type === "music") {
      sounds.push({
        name: a.name,
        displayName: displayName(a.name),
        type: a.type,
        url: a.url,
        trigger:
          a.type === "music"
            ? "Make me a game with music"
            : "Make me a game with sound effects",
      });
    }
    // engine: infrastructure, not a toy — no card.
  }
  return { models, sounds };
}
