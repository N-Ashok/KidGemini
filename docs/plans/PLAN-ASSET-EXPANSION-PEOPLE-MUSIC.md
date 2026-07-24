# Plan — expand the 3D model library + music (2026-07-24)

Owner request: more people (man/woman/child/boy/girl) **and everything else** —
cars, buildings, cities, etc. Plus more commercial-use-free music.

Read first: `docs/PRD-3D-GAMES-AND-ASSETS.md` §4 (gathering), §8 (budgets),
§14 (scale ceilings — the retrieval step).

---

## 0. The headline finding: acquisition is not the bottleneck

| | count |
|---|---|
| GLB models sitting in `.assets-out/cache/` **already downloaded** | **1100** |
| Kenney models actually in the manifest | 84 |
| **Untapped, already on disk, already CC0, already licence-cleared** | **1016** |

Nine Kenney kits are cached and we mapped only a thin slice of each:

| kit | GLBs in zip | mapped | untapped |
|---|---|---|---|
| nature-kit | 329 | 8 | 321 |
| platformer-kit | 153 | 20 | 133 |
| racing-kit | 112 | 6 | 106 |
| food-kit | 200 | 19 | 181 |
| castle-kit | 76 | 9 | 67 |
| car-kit | 50 | 9 | 41 |
| city-kit-commercial | 41 | 3 | 38 |
| city-kit-suburban | 40 | 4 | 36 |
| blocky-characters | 18 | 6 | 12 |

Kenney's 3D catalogue is also **4 pages (~60 kits)**; we use 9. Unused and
directly relevant: `city-kit-industrial`, `fantasy-town-kit`, `modular-dungeon-kit`,
`modular-space-kit`, `pirate-kit`, `graveyard-kit`, `factory-kit`, `mini-forest`,
`cube-pets`, `mini-dungeon`, `modular-cave-kit`, `blaster-kit`.

**So "how do we download them" is largely already answered — we don't need to.**
The bulk of the expansion is extracting files we hold, via a pinned-URL mechanism
that already exists. No new source kind, no new licence review, no network.

---

## 1. The real bottleneck: retrieval, not assets

`src/lib/assets/model-select.ts` is what stops the library scaling — and it will
**actively degrade quality** if we add models without fixing it first.

`selectModelNames()` builds a `Set` in four priority tiers then does
`.slice(0, PROMPT_MODEL_CAP /* 30 */)`. Within tier 3 (genre matches) it inserts
*every* model of *every* matching genre, in genre-declaration order. There is **no
ranking** — the cut is arbitrary insertion order.

This already bites today at 106 models. A kid saying *"a city game with cars"*
matches `city` (17 models) + `racing` (16) = 33 → over cap → tier-4
`CORE_MODELS` (coin, star, tree, car, dog, rocket) are **silently dropped**.

Scale that to a 40-model city genre and one genre alone busts the cap, so which
30 models the LLM learns depends on array position, not relevance.

**Therefore: fix selection before bulk-adding models.** Needed changes:
- Rank within a genre (relevance score) instead of relying on insertion order.
- Per-genre quotas so one matching genre cannot starve another or the core set.
- Guarantee `CORE_MODELS` survive the cut (they are the fallback vocabulary).
- Log when the cap truncates, so silent starvation is visible (CLAUDE.md §9 —
  "silent drop" is a named bug class in this repo).

This is the one part of the work with genuine regression risk, and it needs tests
before any bulk import.

---

## 1a. The LLM currently designs games half-blind — and it gets worse as we grow

Owner question (2026-07-24): *"if the LLM doesn't know what's available with us,
how will it design the game accordingly?"* This is correct and it is the most
important finding in this plan.

**The mismatch:** `selectModelNames()` picks models from **the child's words**,
but the catalogue is consumed by **the LLM's design decisions**, which happen
*after* selection. The child never says the words the designer needs.

Trace *"make me a fun game"*: no genre trigger fires, nothing is named, no prior
artifact — so tiers 1–3 contribute nothing and the LLM is taught only
`CORE_MODELS`: **coin, star, tree, car, dog, rocket. Six models out of 106.**
It then decides to build a pizza restaurant, is told *"NEVER invent a model
name… build it from the primitive shapes instead"* (`prompt-catalog.ts:111-113`),
and hand-rolls cubes — while 19 food models sit unused on the asset host.

This degrades as the library grows: the prompt shows 30/106 = 28% of the library
today, and would show 30/300 = **10%** after this plan. Retrieval-lite makes the
expansion *actively counterproductive* unless fixed.

**The pipeline is not the constraint — only the LLM's knowledge is.**
`inject.ts:74` builds `modelsByName` from the **full manifest**, not from the
prompt selection. Any manifest model the LLM names resolves and loads correctly
today. We are withholding names the delivery path already supports.

### 1a-i. The fix also closes an open cost bug

`docs/COST_TOKEN_BUDGET.md` waste-ledger item **#4 (OPEN, ~₹20–30/day)**:

> *"Prefix caching likely never hits — the builder system prompt varies per
> message (retrieval-lite re-picks models), breaking Gemini implicit caching on
> the otherwise append-only request prefix… Fix: stabilize the builder system
> prompt per conversation."*

The cause named in our own cost doc **is** per-message retrieval. And the damage
is far bigger than the catalogue itself: the varying 150–290-token catalogue sits
*in front of* ~10–15k tokens of repeated game code, so it forfeits the ~70–90%
cached-input discount **on all of it**.

### 1a-ii. Recommendation — make the model catalogue static and complete

Teach **every** model name, every 3D turn, grouped by category:

```
**Ready-made 3D models** — the full toy box:
  people:    man, woman, boy, girl, grandpa, explorer, …
  vehicles:  car, taxi, fire_truck, delivery_van, gokart, …
  buildings: house, apartment, corner_shop, skyscraper, …
  nature:    oak_tree, pine_tree, cactus, rock, …
  food:      pizza, burger, donut, apple, …
```

- **Cost:** ~600–900 tokens at 300 models (a bare name ≈ 2 tokens). It replaces a
  150–290-token varying block — but because it is **conversation-stable**, it
  caches, and it lets the ~10–15k of game code behind it cache too. **Net cost
  goes down, not up**, while the LLM sees 100% of the library instead of 10%.
- **It deletes a subsystem rather than growing one.** `PROMPT_MODEL_CAP` existed
  to bound prompt tokens; a compact grouped index at our target size no longer
  needs bounding. Per-message model retrieval goes away, which is precisely the
  fix item #4 asks for.
- **Ordering matters:** everything conversation-stable must sit *before*
  anything that varies per message, or the cache breaks at the first difference.

**Trade-off to accept explicitly:** prompt cost now grows linearly with library
size (~3k tokens at 1000 models). At our 300-model target, cached, this is
negligible. The revisit trigger is in §9.

**Measure first**, per item #4's own instruction: capture `cachedContentTokenCount`
before and after on a fixed conversation. If caching does not engage, this becomes
a straight +600-token cost and we fall back to a category-map-plus-retrieval
hybrid (categories and counts static, exact names retrieved).

---

## 1b. Every asset must be uniquely *and meaningfully* named

Owner requirement (2026-07-24): each asset needs something unique to be called by,
so the name itself carries relevance when the child's context arrives.

Today `name` is the only descriptive field, and it is doing four jobs at once:
catalogue key, filename, URL path segment, and the sole retrieval signal. At 300
models that collapses — `tree`, `tree_2`, `tree_3` is unique but tells retrieval
and the LLM nothing.

**Hard constraint:** `name` is baked into the immutable URL
(`{name}.{sha256[0:6]}.glb`, `manifest.ts:65-72`). Renaming an existing asset
means a new URL and a re-upload. **The 106 live names must not change.** This
design is additive only.

### 1b-i. Naming convention for new assets

`NAME_RE = /^[a-z0-9_]{2,32}$/` stays. Convention for the ~200 new models:
**`{specific}_{category}`**, never a bare numeric suffix.

- Good: `oak_tree`, `pine_tree`, `dead_tree`, `fire_truck`, `delivery_van`,
  `corner_shop`, `traffic_light`, `road_junction`
- Banned: `tree_2`, `building_7`, `car_b` — carries no retrieval signal

`validateManifest` gains a rule rejecting `_\d+$` suffixes on new entries, so the
convention is machine-enforced rather than a habit.

### 1b-ii. Relevance metadata on the entry

Add two optional fields to `AssetEntry` (pure metadata — they do not affect
`sha256`, the URL, or immutability, so this is safe and additive):

```ts
export interface AssetEntry {
  // …existing fields unchanged…
  /** Synonyms/keywords a kid might actually say. Drives retrieval scoring.
   *  Lowercase, deduped. e.g. fire_truck → ["fire", "engine", "emergency",
   *  "rescue", "siren", "truck"] */
  tags?: string[];
  /** Genre buckets this asset belongs to. Replaces the hardcoded
   *  GENRES[].models arrays in model-select.ts. */
  genres?: string[];
}
```

**Why `genres` moves into the manifest:** CLAUDE.md §4 Open/Closed — "add new
models by extending config, not by editing call sites." Today adding a model
means editing a hand-maintained array in `model-select.ts`; at 300 models those
arrays become the bug surface. Genre membership belongs on the asset.

`GENRES` in `model-select.ts` keeps its `label` + `trigger` regex (the
message→genre matcher) but drops `models` — membership is derived from the
manifest instead. `PEOPLE_MODELS` likewise becomes a derived query
(`genres.includes("people")`), removing the "must stay in lockstep" coupling
called out in the current comment at `model-select.ts:21-27`.

### 1b-iii. What `tags` and `genres` are for, given §1a

With a static complete catalogue (§1a-ii), retrieval no longer gates *which names
the LLM sees* — so tags are **not** a prompt-selection mechanism. They earn their
place three other ways:

1. **Grouping the static index.** `genres` is what renders the category headings
   above; without it the index is a flat 300-name wall the LLM must parse.
2. **Gallery search** (`src/app/assets/page.tsx`) — kids browsing "Game Stuff"
   can find `fire_truck` by typing "emergency".
3. **The fallback path.** If caching does not engage (§1a-ii) and we revert to a
   hybrid, scored retrieval needs exactly this metadata. Building it now keeps
   that option open at no extra cost.

Genre membership still moves out of `model-select.ts` regardless — the
hand-maintained arrays are the wrong home at 300 models either way.

### 1b-iv. Cost

- Manifest: ~37 KB → ~110 KB at 300 entries, plus ~25 KB of tags. Imported into
  the server bundle; fine at this size.
- **Tags do NOT go into the prompt** — only names and category headings do.
- Tag authoring for ~200 models is the main manual effort in this plan. Generate
  a first pass from the kit's own source filename + category, then hand-review.

---

## 2. Licence rule (eliminated two popular sources)

Assets ship inside sandboxed HTML artifacts, so we redistribute the file itself.
`manifest.ts:82-93` enforces `license === "CC0"` + an `https://` `sourceUrl`.

- **Pixabay** — dropped CC0 in 2019. Rejected.
- **Tallbeard / Abstraction "Music Loop Bundle"** — **rejected.** itch.io page
  says CC0; abstractionmusic.com says *"attribution is required… you must include
  a link to either the Bandcamp page or home page."* Same rightsholder,
  contradictory terms. Ambiguity is disqualifying here.
- **FreePD** — site shut down. **Incompetech** — CC-BY, PRD-blacklisted.

Survivors: **Kenney** (License.txt inside every zip), **OpenGameArt** (CC0 filter,
verified per asset — OGA also hosts CC-BY and GPL), **poly.pizza** (CC0 filter).

---

## 3. Download mechanics — no new machinery needed

| source | mechanism | status |
|---|---|---|
| Kenney kits | pinned hashed zip URL + `innerPath` | `kind: 'kenney-zip'` — **exists** |
| poly.pizza | direct `static.poly.pizza/<uuid>.glb` | `kind: 'url'` — **exists** |
| OpenGameArt | direct file URL | `kind: 'url'` — **exists** |
| quaternius.com | button-driven, no stable href | **not fetchable** → use poly.pizza mirrors |
| itch.io | session-scoped signed URL after CSRF POST | **not fetchable** |

Kenney zip URLs embed a content hash
(`.../8369c0cf30-1749547469/kenney_blocky-characters_20.zip`) — copy from the
live asset page, never construct.

---

## 4. What to add, by category

Target ~250–300 models total (from 106). Not 1100 — see §1; every model added is
prompt-catalogue surface and gallery surface, and the cap is 30 per turn.

### 4a. People (the original ask)
- **12 unused Kenney blocky characters** — `boy`, `person`, `grandpa`, `explorer`,
  `businessman`, `knight`, `ninja`, `zombie` ×2, `mascot`, etc. ~63 KB each, same
  rig, same 27 clips, no prompt changes. Names provisional: the kit's
  `Overview.html` has no semantic names, only letters — confirm against
  high-res previews.
- **Honest limit:** all 18 share one *adult* blocky body. `boy` is a re-skin, not
  a child's proportions; today's `girl` is likewise a ponytail variant.
- **True child proportions** (owner approved raising people budget to ~160 KB):
  Quaternius **Universal Base Characters** has a **Teen** proportion in M/F, CC0.
  Ships via poly.pizza mirror. See §5 for why this is sequenced last.

### 4b. Vehicles — car-kit (41 untapped) + racing-kit (106 untapped)
Sedans, vans, buses, delivery trucks, race variants, road pieces (junctions,
ramps, bridges, barriers, cones, tyre walls). Target ~35 more.

### 4c. Buildings & cities — city-kit-commercial (38) + city-kit-suburban (36)
+ new `city-kit-industrial`, `fantasy-town-kit`
Roads, junctions, pavements, street furniture, traffic lights, houses,
storefronts, warehouses. Target ~45 more. This is the weakest current category —
3 commercial + 4 suburban models cannot build a city.

### 4d. Nature & environment — nature-kit (321 untapped)
Ground/terrain tiles, cliffs, water, varied trees, plants, rocks. Target ~35.
Biggest untapped kit; also the most redundant (many near-duplicate variants), so
curate hard rather than importing wholesale.

### 4e. Platformer & props — platformer-kit (133 untapped)
Blocks, platforms, hazards, level pieces. Target ~25.

### 4f. Interiors / dungeons / space — new kits
`modular-dungeon-kit`, `modular-space-kit`, `pirate-kit`, `graveyard-kit`.
Target ~30. Requires downloading 4 new pinned zips.

---

## 5. Music and SFX

`AUDIO_BUDGET_BYTES = 500_000` per game, `BUDGET_BYTES.music = 400_000`. At
96 kbps mono that's ~33 s per track and **~2 music tracks max per game**. Goal is
a wider catalogue to select from, not more audio per game.

- **Music loops → OpenGameArt, fully autonomous.** Direct URLs, no auth; already
  the proven path for both existing loops. Add ~4 moods to reach 6:
  `bg_loop_playful`, `bg_loop_tense`, `bg_loop_victory`, `bg_loop_spooky`.
  Verify CC0 on each asset page individually.
- **SFX → two unused Kenney packs** via existing `KENNEY_ZIPS`:
  **UI Audio** (confirm, error, back, toggle, pop — biggest gap: we have 1 UI
  sound) and **RPG Audio** (footsteps, doors, chest).
- Skipped deliberately: Casino Audio (theme), Voiceover Packs (English-only
  speech → localisation debt).

---

## 6. Sequence — retrieval first, then bulk

0. **Measure prefix caching** on a fixed conversation
   (`cachedContentTokenCount`) — the baseline for §1a-ii, per waste-ledger #4's
   "measure first". Cheap, and it decides step 1.
1. **Static complete catalogue** (§1a-ii) — render all model names grouped by
   category; retire per-message model retrieval from the system prompt; order
   stable-before-varying. **+ tests.** Re-measure caching. Nothing else lands
   before this: it is what makes a bigger library help rather than hurt.
2. **Schema** (§1b) — add `tags`/`genres` to `AssetEntry`, backfill for the
   existing 106, move genre membership out of `model-select.ts`, enforce the
   naming convention in `validateManifest`.
3. Kenney characters (12) + `PEOPLE_MODELS`, `EMOJI` in `gallery.ts`,
   `IRREGULAR_PLURALS`. Dry-run to measure real bytes.
4. Vehicles + city/buildings (§4b, §4c) — largest gameplay win.
5. Nature, platformer props (§4d, §4e).
6. New kits (§4f) — 4 new pinned zip URLs.
7. Audio: UI Audio + RPG Audio + OpenGameArt music.
8. **Last, separately:** 160 KB per-entry budget override + Quaternius teen models.

Steps 3–7 are additive data changes. Steps 1, 2 and 8 touch logic and ship alone.
After each bulk step, re-check the catalogue's token cost against §1a-ii.

---

## 7. The 160 KB budget change (step 7)

Implement as a **per-entry `budgetBytes` override capped at 160_000**, not a raise
of `BUDGET_BYTES.model` — a 60% global rise would silently permit bloat across all
106+ models. `validateEntry()` must reject overrides above the cap and on
non-model types (fail closed).

Risks to verify, not hand-wave:
- **First-load budget.** `FIRST_LOAD_BUDGET_BYTES = 2_000_000`. Three 160 KB
  characters = 480 KB ≈ 24% of one game's budget.
- **Second rig.** Quaternius clip names won't match the Kenney vocabulary
  (`static, idle, walk, sprint, sit, drive, die, pick-up, emote-*, interact-*`).
  The people-clips prompt line assumes one shared vocabulary. **Normalise clip
  names at vendor time** so the LLM keeps a single contract.
- **Visual mixing.** Smooth-shaded Quaternius humans beside blocky Kenney ones
  look inconsistent; consider gating them to different genres.

---

## 8. Tests required

- `model-select.ts` — scoring is deterministic and stable-sorted; a tag match
  outranks a genre match; two matching genres never starve `CORE_MODELS`;
  artifact-pinned models are never dropped; truncation logs; cap still 30.
  **Regression-locked:** "city game with cars" must retain the core basics.
- `manifest.ts` — `tags`/`genres` optional and back-compatible (entries without
  them still validate); tags lowercase + deduped; **new entries with a `_\d+$`
  name suffix are rejected**; the 106 existing names/URLs are unchanged.
- Genre membership derived from the manifest matches the previous hardcoded
  arrays for the existing 106 — a pinned snapshot test, so the migration is
  provably behaviour-preserving before new models land.
- `manifest.ts` — `budgetBytes` override accepts ≤160 KB, **rejects >160 KB**,
  rejects on non-model types.
- `inject.ts` — 3 oversized people models still respect `FIRST_LOAD_BUDGET_BYTES`
  and drop fail-soft.
- `gallery.ts` — every new model has an emoji and renders; no unnamed entries.
- Clip-name normalisation for Quaternius, if step 7 lands.

---

## 9. Scale ceilings (CLAUDE.md §10)

- **Prompt selection** — hard ceiling is `PROMPT_MODEL_CAP = 30` per turn. The
  manifest is unbounded, but retrieval quality degrades as the library grows.
  Trigger to revisit: kids reporting the model "forgot" an asset they asked for,
  or truncation logs firing on most turns. Next step would be embedding-based
  retrieval instead of regex genres.
- **Gallery page** — `src/app/assets/page.tsx` renders the whole manifest.
  At ~300 models this needs pagination or lazy images. Trigger: page weight
  >1 MB or LCP regression.
- **Manifest file size** — 37 KB at 120 entries → ~110 KB at 300. It is imported
  into the server bundle; fine at this size, revisit past ~1000 entries.
- **Per-entry 160 KB override** — ceiling is the 2 MB first-load budget.
  Trigger: scenes needing >6 people models.
