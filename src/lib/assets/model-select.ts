// Genre triggers + retrieval-lite model selection (PRD §14's "retrieval step",
// built 2026-07-13 when the library headed past 30).
//
// ⚠️ selectModelNames is NO LONGER WIRED INTO THE PROMPT (2026-07-24). The
// build-turn catalog now teaches the whole library statically — see the long
// note on modelsPromptSection in prompt-catalog.ts for why (short version:
// selection ran on the CHILD's words but the catalog is consumed by the LLM's
// DESIGN decisions, so "make me a fun game" taught 6 of 106 models; and a
// per-message system prompt breaks Gemini prefix caching). It is retained as
// the documented fallback if the static catalog's token ceiling is ever
// breached — the hybrid would keep headings static and retrieve exact names.
//
// GENRES is still live: it supplies the category headings the static catalog
// renders. Membership itself lives on the assets (asset-taxonomy.ts).

import type { ChatMessage } from "@/types/chat.types";
import type { AssetManifest } from "./manifest";
import manifestJson from "./manifest.json";
import { type GenreId, modelsInGenre, modelsWithRig } from "./asset-taxonomy";

export interface GenreDef {
  /** Taxonomy bucket this genre draws from. */
  id: GenreId;
  /** Human label — also rendered as the hint-line heading in the prompt. */
  label: string;
  /** Message/history pattern that pulls this genre's models into the prompt. */
  trigger: RegExp;
}

/** The human characters (Kenney Blocky Characters, 2026-07-19): one shared rig,
 *  every model carries the same clips (idle, walk, sprint, sit, drive, die,
 *  pick-up, emote-yes/no, interact). Derived from the taxonomy's `rig` field
 *  rather than the `people` genre — that genre also holds `grandstand`, and a
 *  stadium must never be described to the model as having a walk cycle. */
export function peopleModels(available: ReadonlySet<string>): string[] {
  return modelsWithRig("kenney_blocky", available);
}

/** The soldier characters (Quaternius CharacterArmature, 2026-07-29 military
 *  batch 2). A SEPARATE rig from the Kenney people with entirely different
 *  clip names — telling the model a soldier has a "sprint" or "emote-yes" clip
 *  is exactly the confident-but-wrong instruction the rig split exists to
 *  prevent, so they get their own prompt line. */
export function soldierModels(available: ReadonlySet<string>): string[] {
  return modelsWithRig("quaternius_soldier", available);
}

/** Genre triggers. Membership lives on the assets (asset-taxonomy.ts), so
 *  adding a model can no longer desync from selection or the prompt hints. */
export const GENRES: readonly GenreDef[] = [
  {
    id: "people",
    label: "people / crowd",
    trigger: /\b(people|humans?|persons?|crowds?|stadiums?|cheer(ing|s)?|audience|spectators?|man|men|woman|women|boys?|girls?|kids?|walk(ing)?|runn(ing|ers?)|sit(ting)?|scientists?|police\s?officers?|pirates?)\b/i,
  },
  {
    id: "racing",
    label: "racing / driving",
    // Motorcycle words added 2026-08-06 (docs/2026-08-06_PRD_MotorcycleAssets.md).
    // "bike"/"bikes" deliberately included: kids call motorcycles "bikes", and
    // the racing set is the right destination for a bicycle ask too (closest
    // thing the library has).
    // Road/highway words added with the roads batch (2026-08-06).
    trigger: /\b(rac(e|ing|er)|driv(e|ing)|cars?|trucks?|police|taxis?|tractors?|ambulances?|chase|track|go-?karts?|motor\s?cycles?|motor\s?bikes?|bikes?|bikers?|scooters?|scooty|mopeds?|stunts?|wheelies?|roads?|highways?|flyovers?|ramps?)\b/i,
  },
  {
    id: "platformer",
    label: "platformer / collecting",
    trigger: /\b(platform(er)?|jump(ing|er)?|collect(ing)?|coins?|maze|runner?|obstacles?)\b/i,
  },
  {
    id: "space",
    label: "space / flying",
    // airport/runway/airplane words added with the jets batch (2026-08-06).
    trigger: /\b(space(ship)?|rockets?|aliens?|planets?|fly(ing)?|jets?|planes?|helicopters?|ufos?|galaxy|stars?|air(planes?|crafts?|ports?|force)|aeroplanes?|runways?|pilots?)\b/i,
  },
  {
    id: "animals",
    label: "animals / pets",
    // Species words added 2026-08-09 (docs/2026-08-09_PRD_AnimalsSnowSkiAssets.md).
    // "jungle"/"safari" ride here as well as in nature: a kid asking for a
    // jungle game wants the crocodile and the monkey, not only the trees.
    trigger: /\b(animals?|pets?|dogs?|cats?|puppy|kitten|birds?|chickens?|bees?|bunny|zoo|dinos?(aurs?)?|farm|jungle|safari|crocodiles?|alligators?|elephants?|lions?|tigers?|monkeys?|apes?|gorillas?|deers?|stags?|wolf|wolves|foxe?s?|horses?|ponys?|ponies|donkeys?|zebras?|pandas?|snakes?|frogs?)\b/i,
  },
  {
    // Snow / winter batch (2026-08-09, same PRD). Deliberately NOT the bare
    // word "board" (skateboard/surfboard/whiteboard) or "gate" (castle) —
    // the same over-triggering lesson the cricket trigger's comment records.
    id: "snow",
    label: "snow / skiing",
    trigger: /\b(snows?|snowy|snowballs?|snowmen|snowman|winter|ice|icy|frozen|frost|ski|skis|skiing|skier|snowboard(ing|er)?|sled(ge|ding)?|sleighs?|toboggans?|slaloms?|chair\s?lifts?|ski\s?lifts?|mountains?|igloos?|arctic|blizzards?|avalanches?)\b/i,
  },
  {
    id: "castle",
    label: "castle / adventure",
    trigger: /\b(castles?|knights?|swords?|adventure|quest|dragons?|ghosts?|spooky|hallowe+n|monsters?|bats?|dungeons?|catapults?|hero(es)?|siege)\b/i,
  },
  {
    id: "city",
    label: "city",
    // "bridge(s)" added with the bridges batch (2026-08-06): kids say "bridge
    // game" with no other city word, and the city set holds the bridges.
    trigger: /\b(city|cities|town|buildings?|skyscrapers?|streets?|traffic|apartments?|shops?|offices?|bridges?|flyovers?)\b/i,
  },
  {
    id: "nature",
    label: "forest / nature",
    // Rain-forest words added 2026-08-09 (owner ask).
    trigger: /\b(forests?|jungles?|rain\s?forests?|nature|trees?|camping|mushrooms?|woods|desert|bamboo|vines?|ferns?|canopy|savann?ah?|tropical)\b/i,
  },
  {
    id: "water",
    label: "water / sailing",
    // River words added 2026-08-09 (owner ask): a kid saying "river" gets the
    // channel tiles, the waterfall, the lily pads and the log to cross on.
    trigger: /\b(water|ocean|seas?|boats?|ships?|sail(ing)?|sharks?|swim(ming)?|under\s?water|pirates?|fish(ing)?|dolphins?|canoes?|rivers?|streams?|creeks?|rapids?|waterfalls?|ponds?|lakes?|lily\s?pads?)\b/i,
  },
  {
    id: "food",
    label: "food / cooking",
    trigger: /\b(foods?|cook(ing)?|kitchen|restaurants?|burgers?|pizzas?|ice\s?creams?|donuts?|apples?|eat(ing)?|hungry|snacks?)\b/i,
  },
  {
    // Sports batch (2026-07-26, docs/2026-07-26_PRD_SportsAssets.md).
    // "beyblade" matches the kid's own word for the unbranded battle tops —
    // triggers are matched against their message, never rendered back out.
    id: "sports",
    label: "sports / football",
    // Cricket words added 2026-07-29. Deliberately NOT the bare words "ball",
    // "run", "over" or "bat" — every other kind of game uses those, and
    // over-triggering would drag the whole cricket set into unrelated prompts
    // (pinned by test). "bat" alone also collides with the animal.
    trigger: /\b(sports?|soccer|football(er)?s?|goals?|goal\s?keeper|penalt(y|ies)|kick(ing|s)?|strikers?|match(es)?|beyblades?|spinning\s?tops?|battle\s?tops?|cricket(ers?)?|wickets?|stumps?|bails?|batsm[ae]n|batters?|bowlers?|bowling|innings|sixers?|umpires?|googly|crease)\b/i,
  },
  {
    // Military batch (2026-07-29, docs/2026-07-29_PRD_MilitaryAssets.md).
    // "soldier"/"gun" are TRIGGER words, not model names: kids say them for a
    // war game, and matching them routes the ask to the tanks and forts we DO
    // ship. Triggers are matched against the child's message and never
    // rendered back out, so this teaches no weapon the library doesn't have.
    id: "military",
    label: "army / battle vehicles",
    trigger: /\b(army|armies|militar(y|ies)|tanks?|soldiers?|wars?|battles?|combat|troops?|bases?|bunkers?|turrets?|cannons?|artillery|forts?|fortress(es)?|sandbags?|barricades?|defen[cs]e|camo(uflage)?|guns?)\b/i,
  },
  {
    // Indian games batch (2026-07-30, docs/2026-07-30_PRD_IndianGamesAssets.md).
    // Kept as its OWN genre (not folded into `sports`): carrom/ludo/marbles are
    // tabletop games, not sports in the football/cricket sense, and the owner
    // asked for a batch scoped to games popular with Indian kids specifically.
    // Deliberately NOT the bare words "striker" (already a sports/football
    // trigger — a football-striker ask should not drag in a carrom board),
    // "coin" (collides with the platformer pickup), "queen"/"pawn"/"token"
    // (chess/generic-pickup collisions), or "net" (soccer goal net, fishing
    // net) — same over-triggering lesson the cricket trigger's own comment
    // documents. "carrom"/"ludo"/"kabaddi" alone are enough to pull each
    // whole set in (genres are the unit of selection).
    id: "indian_games",
    label: "Indian games",
    trigger: /\b(kabaddi|carrom(?:s)?|kho[\s-]?kho|badminton|shuttlecocks?|birdies?|rackets?|racquets?|ludo|dice|marbles?|goli(?:es)?)\b/i,
  },
];

/** Always-available basics: broadly useful in any game idea. */
export const CORE_MODELS: readonly string[] = ["coin", "star", "tree", "car", "dog", "rocket"];

/** Hard per-PROMPT ceiling for the FALLBACK path (PRD §14). Not applied today —
 *  the static catalog teaches every model; see the header note. */
export const PROMPT_MODEL_CAP = 30;

const ARTIFACT_MODELS = /<!--USES_MODELS:([a-z0-9_,\s]*)-->/gi;

/** The three call shapes a generated game uses to name a library model:
 *  `loadModel("x")`, `loadModelBatch("x", n)` and `placeModel("x", opts)` —
 *  the last being the one prompt-catalog.ts now tells the model to PREFER.
 *
 *  Read ALONGSIDE the marker, and it is the shape that actually matters: the
 *  marker is stripped from the artifact at delivery (stripAssetMarkers), so
 *  every artifact in a real history has call sites and NO marker. Matching
 *  only the marker meant step 1 below found nothing on every genuine edit
 *  turn, the game's own models dropped out of the toy box line, and the prompt
 *  then told the model — truthfully, from its side — that they did not exist.
 *  It followed the next instruction and hand-built them out of BoxGeometry.
 *  That is the owner's 2026-08-17 "the skyscrapers have windows in the model
 *  why is it not coming through in the game?": three buildings its earlier
 *  version had used, replaced by 600 hand-lit cubes.
 *
 *  Marker kept as well, not replaced: it is the only signal on HTML that has
 *  not been through injection yet (CLAUDE.md rule 11 — add the new source
 *  ahead of the old, keep the old as a fallback). */
const ARTIFACT_MODEL_CALLS = /\b(?:loadModel|loadModelBatch|placeModel)\s*\(\s*['"`]([a-z0-9_]+)['"`]/gi;

/**
 * FALLBACK PATH — not currently wired into the prompt (see the header note).
 *
 * Pick which model names this turn's prompt should teach. Priority when the
 * cap bites: models the existing game uses > names the kid said > genre
 * matches > core basics. Libraries at or under the cap skip selection —
 * behavior is unchanged until scale demands it.
 */
export function selectModelNames(input: {
  message: string;
  history: ChatMessage[];
  manifest?: AssetManifest;
}): string[] {
  const manifest = input.manifest ?? (manifestJson as AssetManifest);
  const available = manifest.assets.filter((a) => a.type === "model").map((a) => a.name);
  if (available.length <= PROMPT_MODEL_CAP) return available;

  const availableSet = new Set(available);
  const texts = [input.message, ...input.history.filter((m) => m.role === "child").map((m) => m.text)].join("\n");
  const artifacts = input.history.map((m) => m.artifactHtml ?? "").join("\n");

  const picked = new Set<string>();
  // 1. Models the game being iterated on already uses — dropping one would
  //    make the model unable to keep its own game working. Read from BOTH the
  //    marker (pre-injection HTML) and the loadModel/loadModelBatch/placeModel
  //    CALL SITES (post-injection HTML, i.e. everything actually stored). See
  //    ARTIFACT_MODEL_CALLS above for why the call sites had to be added.
  //    Unknown names are dropped by `availableSet`, so a hallucinated
  //    `loadModel("unicorn_castle")` can never be offered back as real.
  for (const match of artifacts.matchAll(ARTIFACT_MODELS)) {
    for (const raw of (match[1] ?? "").split(",")) {
      const name = raw.trim().toLowerCase();
      if (availableSet.has(name)) picked.add(name);
    }
  }
  for (const match of artifacts.matchAll(ARTIFACT_MODEL_CALLS)) {
    const name = match[1]!.toLowerCase();
    if (availableSet.has(name)) picked.add(name);
  }
  // 2. Models the kid named outright.
  for (const name of available) {
    if (new RegExp(`\\b${name}\\b`, "i").test(texts)) picked.add(name);
  }
  // 3. Genre keyword matches.
  for (const genre of GENRES) {
    if (genre.trigger.test(texts)) {
      for (const name of modelsInGenre(genre.id, availableSet)) picked.add(name);
    }
  }
  // 4. The core basics, last (first to fall off at the cap).
  for (const name of CORE_MODELS) if (availableSet.has(name)) picked.add(name);

  return [...picked].slice(0, PROMPT_MODEL_CAP);
}
