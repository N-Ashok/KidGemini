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
  /** CC-BY entries only: the credit line the license requires, ready to
   *  render ("by Zsky · CC BY 3.0"), and where it links. Absent for CC0. */
  credit?: { author: string; sourceUrl: string; license: string };
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

  // Sports batch (2026-07-26, docs/2026-07-26_PRD_SportsAssets.md).
  soccer_ball: "⚽",
  soccer_goal: "🥅",
  footballer: "⛹️",
  footballer_blue: "🏃",
  battle_top: "🌀",
  blade_top: "💫",

  // People (2026-07-19: stadium humans — Kenney Blocky Characters).
  man: "🧍",
  woman: "🧍‍♀️",
  girl: "👧",
  scientist: "🧑‍🔬",
  police_officer: "👮",
  pirate: "🏴‍☠️",

  // City + vehicles batch 2 (2026-07-24).
  office_small: "🏢", office_wide: "🏢", office_block: "🏢",
  flats: "🏬", garden_apartment: "🏡", long_office: "🏢",
  narrow_tower: "🗼", mall: "🏬",
  glass_tower: "🏙️", antenna_tower: "📡", white_tower: "🏙️",
  awning: "⛱️", parasol: "🏖️",
  family_house: "🏠", bungalow: "🏠", cottage: "🏡", town_house: "🏘️",
  dark_house: "🏚️", porch_house: "🏡", modern_house: "🏠", modern_villa: "🏛️",
  stilt_house: "🏕️", garage_house: "🏠",
  fence: "🚧", low_fence: "🚧", garden_path: "🛤️", stone_path: "🪨",
  short_driveway: "🛣️", small_tree: "🌲",
  sedan: "🚙", sports_car: "🏎️", hatchback: "🚗", suv: "🚙", luxury_suv: "🚙",
  van: "🚐", delivery_van: "📦", truck: "🚚", digger: "🚜",
  future_car: "🛸", race_kart: "🏎️", traffic_cone: "🚧",

  // The rest of the kit's 18 (2026-07-24).
  grandpa: "👴",
  gamer: "🎮",
  mascot: "🦸",
  mech: "🤖",
  purple_mech: "🤖",
  plumber: "🔧",
  zombie: "🧟",
  explorer: "🧭",
  kimono_woman: "👘",
  orc: "👹",
  businessman: "🕴️",
  ninja: "🥷",

  // Military batch (2026-07-29). No weapon emoji on a kid-facing card — the
  // cards lean on the vehicle/fortification, same as the models themselves.
  tank: "🪖",
  tank_desert: "🏜️",
  tank_toy: "🛺",
  tank_rusty: "⚙️",
  armored_truck: "🛡️",
  armored_pickup: "🚙",
  turret: "🎯",
  turret_cannon: "💥",
  cannon: "🧨",
  sandbags: "🧱",
  sandbags_small: "🧳",
  barricade: "🚧",
  bunker: "🛖",
  watchtower: "🗼",
  radar: "📡",
  chain_fence: "🔗",

  // Military batch 2 (2026-07-29): soldiers + hand-held weapons.
  soldier: "🪖",
  hazmat: "🥽",
  rifle: "🔫",
  assault_rifle: "🔫",
  sniper_rifle: "🎯",
  shotgun: "🔫",
  pistol: "🔫",
  revolver: "🤠",
  submachine_gun: "🔫",
  rocket_launcher: "🚀",
  grenade_launcher: "💣",
  bazooka: "🚀",
  grenade: "💣",
  landmine: "⚠️",
  flare_gun: "🎆",
  laser_gun: "⚡",
  space_rifle: "👾",
  space_pistol: "🛸",
  bullets: "📿",
  shield: "🛡️",

  // Cricket batch (2026-07-29).
  cricket_bat: "🏏",
  cricket_ball: "🔴",
  wicket: "🪵",
  cricket_pitch: "🟩",
  sight_screen: "⬜",
  cricketer: "🧢",
  trophy: "🏆",

  // Indian games batch (2026-07-30, docs/2026-07-30_PRD_IndianGamesAssets.md).
  kabaddi_mat: "🟧",
  kabaddi_player: "🤼",
  carrom_board: "🟫",
  carrom_striker: "🎯",
  carrom_coin_white: "⚪",
  carrom_coin_black: "⚫",
  carrom_queen: "🔴",
  kho_kho_pole: "📍",
  kho_kho_lane_field: "🟩",
  kho_kho_player: "🏃",
  badminton_racket: "🏸",
  shuttlecock: "🪶",
  badminton_net: "🥅",
  ludo_board: "🟦",
  ludo_dice: "🎲",
  ludo_pawn_red: "🔴",
  ludo_pawn_green: "🟢",
  ludo_pawn_yellow: "🟡",
  ludo_pawn_blue: "🔵",
  marble: "🔮",
  marble_blue: "🔵",
  marble_green: "🟢",

  // Motorcycle batch (2026-08-06).
  motorcycle: "🏍️",
  sport_bike: "🏍️",
  race_bike: "🏍️",
  dirt_bike: "🏍️",
  cruiser_bike: "🏍️",
  chopper_bike: "🏍️",
  police_bike: "🚨",
  scooter: "🛵",
  moped: "🛵",
  delivery_bike: "📦",
  mini_bike: "🏍️",
  military_motorbike: "🪖",
  street_motorcycle: "🏍️",

  // Roads / bridges / jets batch (2026-08-06).
  road_straight: "🛣️",
  road_curve: "🛣️",
  road_intersection: "🛣️",
  road_crossing: "🚸",
  road_roundabout: "🔄",
  road_ramp: "🛣️",
  road_bridge: "🌉",
  bridge_pillar: "🏗️",
  highway_sign: "🪧",
  wooden_bridge: "🌉",
  truss_bridge: "🌉",
  suspension_bridge: "🌉",
  elevated_road: "🌁",
  fighter_jet: "🛩️",
  // (`airplane` already has its ✈️ in the legacy rows above)
  small_plane: "🛩️",
  seaplane: "🛩️",
  biplane: "🛩️",
  private_jet: "✈️",
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
  businessman: "businessmen",
  "kimono woman": "kimono women",
};

function plural(name: string): string {
  const irregular = IRREGULAR_PLURALS[name];
  if (irregular) return irregular;
  // Kids read these trigger phrases in the gallery, so a wrong plural is a
  // visible typo. Handled as RULES, not a growing special-case list:
  //   already plural → unchanged  ("cherries", never "cherriess")
  if (/s$/.test(name)) return name;
  //   consonant + y → -ies        ("strawberry" → "strawberries")
  //   but vowel + y → -s          ("key" → "keys", "driveway" → "driveways")
  if (/[^aeiou]y$/.test(name)) return `${name.slice(0, -1)}ies`;
  return `${name}s`;
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
        ...(a.license === "CC-BY-3.0" && a.author
          ? { credit: { author: a.author, sourceUrl: a.sourceUrl, license: "CC BY 3.0" } }
          : {}),
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
