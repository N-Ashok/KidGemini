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
    trigger: /\b(rac(e|ing|er)|driv(e|ing)|cars?|trucks?|police|taxis?|tractors?|ambulances?|chase|track|go-?karts?)\b/i,
  },
  {
    id: "platformer",
    label: "platformer / collecting",
    trigger: /\b(platform(er)?|jump(ing|er)?|collect(ing)?|coins?|maze|runner?|obstacles?)\b/i,
  },
  {
    id: "space",
    label: "space / flying",
    trigger: /\b(space(ship)?|rockets?|aliens?|planets?|fly(ing)?|jets?|planes?|helicopters?|ufos?|galaxy|stars?)\b/i,
  },
  {
    id: "animals",
    label: "animals / pets",
    trigger: /\b(animals?|pets?|dogs?|cats?|puppy|kitten|birds?|chickens?|bees?|bunny|zoo|dinos?(aurs?)?|farm)\b/i,
  },
  {
    id: "castle",
    label: "castle / adventure",
    trigger: /\b(castles?|knights?|swords?|adventure|quest|dragons?|ghosts?|spooky|hallowe+n|monsters?|bats?|dungeons?|catapults?|hero(es)?|siege)\b/i,
  },
  {
    id: "city",
    label: "city",
    trigger: /\b(city|cities|town|buildings?|skyscrapers?|streets?|traffic|apartments?|shops?|offices?)\b/i,
  },
  {
    id: "nature",
    label: "forest / nature",
    trigger: /\b(forests?|jungle|nature|trees?|camping|mushrooms?|woods|desert)\b/i,
  },
  {
    id: "water",
    label: "water / sailing",
    trigger: /\b(water|ocean|seas?|boats?|ships?|sail(ing)?|sharks?|swim(ming)?|under\s?water|pirates?|fish(ing)?|dolphins?|canoes?)\b/i,
  },
  {
    id: "food",
    label: "food / cooking",
    trigger: /\b(foods?|cook(ing)?|kitchen|restaurants?|burgers?|pizzas?|ice\s?creams?|donuts?|apples?|eat(ing)?|hungry|snacks?)\b/i,
  },
];

/** Always-available basics: broadly useful in any game idea. */
export const CORE_MODELS: readonly string[] = ["coin", "star", "tree", "car", "dog", "rocket"];

/** Hard per-PROMPT ceiling for the FALLBACK path (PRD §14). Not applied today —
 *  the static catalog teaches every model; see the header note. */
export const PROMPT_MODEL_CAP = 30;

const ARTIFACT_MODELS = /<!--USES_MODELS:([a-z0-9_,\s]*)-->/gi;

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
  //    make the model unable to keep its own game working.
  for (const match of artifacts.matchAll(ARTIFACT_MODELS)) {
    for (const raw of (match[1] ?? "").split(",")) {
      const name = raw.trim().toLowerCase();
      if (availableSet.has(name)) picked.add(name);
    }
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
