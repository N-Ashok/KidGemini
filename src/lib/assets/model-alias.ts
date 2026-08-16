// Resolve a model name the MODEL invented onto a real one in the library.
//
// WHY (2026-08-16, owner: "some items are genuinely not available in our mesh
// list... the model can better invent their own model"): measured across every
// stored game, the model asked for 99 distinct model names — 97 real (2,657
// uses) and 2 invented (`stegosaurus` x5, `mermaid` x1). Today an invented
// name resolves to nothing, `loadModel` returns null, and the child gets the
// hand-built placeholder. `stegosaurus` should simply get `dino`.
//
// DETERMINISTIC BY DESIGN — no extra model call, no network, pure string work,
// same answer every time.
//
// THE GOVERNING RULE: prefer NO match over a wrong one. A missing model leaves
// the game's own placeholder, which the child already accepts; a WRONG model
// puts a strange object in their world and is much harder to explain. So every
// rule below is narrow, and anything ambiguous returns null.

/** Curated semantic synonyms — the part no string metric can do. Left side is
 *  what a child (or the model) might ask for; right side must exist in the
 *  manifest, which `resolveModelName` verifies rather than trusting. */
export const MODEL_ALIASES: Readonly<Record<string, string>> = {
  // dinosaurs — the measured real-world case
  stegosaurus: "dino",
  tyrannosaurus: "dino",
  t_rex: "dino",
  trex: "dino",
  raptor: "dino",
  velociraptor: "dino",
  triceratops: "dino",
  brontosaurus: "dino",
  dinosaur: "dino",
  // animals children ask for by another name
  puppy: "dog",
  doggy: "dog",
  kitten: "cat",
  kitty: "cat",
  duck: "chicken",
  duckling: "chicken",
  goose: "chicken",
  hen: "chicken",
  rooster: "chicken",
  bunny: "cat",
  pony: "horse",
  foal: "horse",
  cow: "donkey",
  bull: "donkey",
  goat: "deer",
  sheep: "deer",
  lamb: "deer",
  cheetah: "tiger",
  leopard: "tiger",
  jaguar: "tiger",
  panther: "tiger",
  gorilla: "monkey",
  chimp: "monkey",
  chimpanzee: "monkey",
  ape: "monkey",
  whale: "dolphin",
  orca: "dolphin",
  seal: "dolphin",
  crocodile_alligator: "crocodile",
  alligator: "crocodile",
  gator: "crocodile",
  eagle: "bird",
  parrot: "bird",
  owl: "bird",
  penguin: "bird",
  seagull: "bird",
  pigeon: "bird",
  butterfly: "bee",
  wasp: "bee",
  // vehicles
  automobile: "car",
  auto: "car",
  vehicle: "car",
  racecar: "sports_car",
  race_car: "sports_car",
  sportscar: "sports_car",
  motorbike: "motorcycle",
  bike: "sport_bike",
  bicycle: "sport_bike",
  cycle: "sport_bike",
  lorry: "truck",
  semi: "truck",
  bus: "van",
  minibus: "van",
  jeep: "suv",
  plane: "airplane",
  aeroplane: "airplane",
  jet: "fighter_jet",
  chopper: "helicopter",
  ship: "boat",
  yacht: "boat",
  kayak: "canoe",
  raft: "canoe",
  // people
  person: "man",
  human: "man",
  boy: "girl",
  kid: "girl",
  child: "girl",
  lady: "woman",
  doctor: "scientist",
  cop: "police_officer",
  policeman: "police_officer",
  officer: "police_officer",
  knight: "soldier",
  farmer: "man",
  // scenery
  bush: "snow_bush",
  hedge: "snow_bush",
  flower: "star",
  grass: "jungle_grass",
  hill: "hill_block",
  boulder: "rock",
  stone: "rock",
  log_wood: "log",
  building: "office_small",
  skyscraper_tower: "skyscraper",
  hut: "cottage",
  cabin: "cottage",
  barn: "house",
  home: "house",
  // props
  ball: "soccer_ball",
  football: "soccer_ball",
  treasure: "chest",
  box: "crate",
  cone: "traffic_cone",
  money: "coin",
  gold: "coin",
  jewel: "gem",
  diamond: "gem",
};

/** Lowercase, unify separators, drop anything else. */
function normalize(name: string): string {
  return name.trim().toLowerCase().replace(/[\s-]+/g, "_").replace(/[^a-z0-9_]/g, "");
}

/** Naive singular — enough for `ducks`/`trees`/`boxes`, never clever. */
function singular(name: string): string {
  if (name.endsWith("ies") && name.length > 4) return `${name.slice(0, -3)}y`;
  if (name.endsWith("es") && /(?:x|s|z|ch|sh)es$/.test(name)) return name.slice(0, -2);
  if (name.endsWith("s") && !name.endsWith("ss")) return name.slice(0, -1);
  return name;
}

/** Levenshtein, capped — we only ever care about tiny distances. */
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let best = cur[0];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      best = Math.min(best, cur[j]!);
    }
    if (best > max) return max + 1;
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j]!;
  }
  return prev[b.length]!;
}

export interface ResolveResult {
  /** The real model to use, or null when nothing is confidently close. */
  name: string | null;
  /** Which rule fired — for logging, and for tests to pin the reasoning. */
  via: "exact" | "normalized" | "alias" | "plural" | "compound" | "typo" | "none";
}

/**
 * Map a requested model name onto a real one.
 *
 * Order is deliberate: certainty first, guesswork last, and guesswork is
 * narrow. `available` is the set of real manifest names — every rule checks
 * against it, so an alias pointing at a model we later remove degrades to
 * `null` rather than to a broken URL.
 */
export function resolveModelName(requested: string, available: ReadonlySet<string>): ResolveResult {
  if (!requested) return { name: null, via: "none" };
  if (available.has(requested)) return { name: requested, via: "exact" };

  const n = normalize(requested);
  if (!n) return { name: null, via: "none" };
  if (available.has(n)) return { name: n, via: "normalized" };

  const alias = MODEL_ALIASES[n];
  if (alias && available.has(alias)) return { name: alias, via: "alias" };

  const s = singular(n);
  if (s !== n) {
    if (available.has(s)) return { name: s, via: "plural" };
    const sAlias = MODEL_ALIASES[s];
    if (sAlias && available.has(sAlias)) return { name: sAlias, via: "alias" };
  }

  // Compound names: "police_car" -> police, "big_tree" -> tree. Whole tokens
  // only, longest first, so "race_track_corner" prefers the longest real name
  // it contains rather than the first token that happens to exist.
  const tokens = s.split("_").filter(Boolean);
  if (tokens.length > 1) {
    const candidates = [...available].filter((real) => {
      const rt = real.split("_");
      return rt.every((t) => tokens.includes(t));
    });
    if (candidates.length > 0) {
      candidates.sort((a, b) => b.length - a.length || a.localeCompare(b));
      return { name: candidates[0]!, via: "compound" };
    }
  }

  // Typos, last and tightest.
  //
  // SHORT NAMES ARE NOT TYPO-MATCHED AT ALL. Among four-letter words one edit
  // is a different word, not a slip: `lake` -> `cake` was produced by an
  // earlier version of this function and is precisely the "strange object in
  // the child's world" failure this module exists to avoid. A lake we do not
  // have should stay a lake the game draws itself.
  //
  // Above that, one edit, or two once a name is long enough that two edits
  // still leave it unmistakable — and ONLY when a single candidate is that
  // close. A tie means we do not know: `star` and `stag` are both real and one
  // edit apart, so a request one edit from both must resolve to neither.
  const TYPO_MIN_LENGTH = 6;
  if (s.length < TYPO_MIN_LENGTH) return { name: null, via: "none" };
  const max = s.length >= 8 ? 2 : 1;
  let best: string | null = null;
  let bestD = max + 1;
  let tied = false;
  for (const real of available) {
    const d = distance(s, real, max);
    if (d < bestD) {
      bestD = d;
      best = real;
      tied = false;
    } else if (d === bestD) {
      tied = true;
    }
  }
  if (best && bestD <= max && !tied) return { name: best, via: "typo" };

  return { name: null, via: "none" };
}
