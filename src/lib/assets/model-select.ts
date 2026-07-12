// Retrieval-lite model selection (PRD §14's "retrieval step", built
// 2026-07-13 when the library headed past 30): the manifest can hold any
// number of models, but a single prompt carries at most PROMPT_MODEL_CAP —
// chosen by cheap regex from the kid's words, their history, and the models
// the game being iterated on already uses. No LLM call, no I/O; the same
// mechanism scales to hundreds of models at flat prompt cost. Pure logic.

import type { ChatMessage } from "@/types/chat.types";
import type { AssetManifest } from "./manifest";
import manifestJson from "./manifest.json";

export interface GenreDef {
  /** Human label — also rendered as the hint-line heading in the prompt. */
  label: string;
  /** Message/history pattern that pulls this genre's models into the prompt. */
  trigger: RegExp;
  /** Library names that fit the genre (filtered to the manifest at use). */
  models: readonly string[];
}

/** One source of truth for genre → models: drives BOTH prompt selection and
 *  the in-prompt hint lines (prompt-catalog.ts), so they can never disagree. */
export const GENRES: readonly GenreDef[] = [
  {
    label: "racing / driving",
    trigger: /\b(rac(e|ing|er)|driv(e|ing)|cars?|trucks?|police|taxis?|tractors?|ambulances?|chase)\b/i,
    models: ["car", "police", "firetruck", "taxi", "ambulance", "tractor", "coin"],
  },
  {
    label: "platformer / collecting",
    trigger: /\b(platform(er)?|jump(ing|er)?|collect(ing)?|coins?|maze|runner?|obstacles?)\b/i,
    models: ["hero", "coin", "star", "key", "chest", "heart", "gem", "spring", "crate", "barrel", "bomb", "flag", "tree", "mushroom"],
  },
  {
    label: "space / flying",
    trigger: /\b(space(ship)?|rockets?|aliens?|planets?|fly(ing)?|jets?|planes?|helicopters?|ufos?|galaxy|stars?)\b/i,
    models: ["rocket", "spaceship", "ufo", "helicopter", "alien", "star"],
  },
  {
    label: "animals / pets",
    trigger: /\b(animals?|pets?|dogs?|cats?|puppy|kitten|birds?|chickens?|bees?|bunny|zoo|dinos?(aurs?)?|farm)\b/i,
    models: ["dog", "cat", "fish", "bird", "chicken", "bee", "dino"],
  },
  {
    label: "castle / adventure",
    trigger: /\b(castles?|knights?|swords?|adventure|quest|dragons?|ghosts?|spooky|hallowe+n|monsters?|bats?|dungeons?|catapults?|hero(es)?)\b/i,
    models: ["hero", "tower", "key", "chest", "sword", "catapult", "bridge", "ghost", "bat", "dino", "robot", "gem"],
  },
  {
    label: "city",
    trigger: /\b(city|cities|town|buildings?|skyscrapers?|streets?|traffic)\b/i,
    models: ["skyscraper", "house", "car", "police", "firetruck", "helicopter"],
  },
  {
    label: "forest / nature",
    trigger: /\b(forests?|jungle|nature|trees?|camping|mushrooms?|woods)\b/i,
    models: ["pine", "tree", "rock", "bird", "mushroom", "dog"],
  },
  {
    label: "water / sailing",
    trigger: /\b(water|ocean|seas?|boats?|ships?|sail(ing)?|sharks?|swim(ming)?|under\s?water|pirates?|fish(ing)?|dolphins?)\b/i,
    models: ["boat", "fish", "shark", "dolphin", "chest"],
  },
  {
    label: "food / cooking",
    trigger: /\b(foods?|cook(ing)?|kitchen|restaurants?|burgers?|pizzas?|ice\s?creams?|donuts?|apples?|eat(ing)?|hungry|snacks?)\b/i,
    models: ["burger", "ice_cream", "donut", "apple", "chicken"],
  },
];

/** Always-available basics: broadly useful in any game idea. */
export const CORE_MODELS: readonly string[] = ["coin", "star", "tree", "car", "dog", "rocket"];

/** Hard per-PROMPT ceiling (PRD §14 — the manifest itself is unbounded). */
export const PROMPT_MODEL_CAP = 30;

const ARTIFACT_MODELS = /<!--USES_MODELS:([a-z0-9_,\s]*)-->/gi;

/**
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
      for (const name of genre.models) if (availableSet.has(name)) picked.add(name);
    }
  }
  // 4. The core basics, last (first to fall off at the cap).
  for (const name of CORE_MODELS) if (availableSet.has(name)) picked.add(name);

  return [...picked].slice(0, PROMPT_MODEL_CAP);
}
