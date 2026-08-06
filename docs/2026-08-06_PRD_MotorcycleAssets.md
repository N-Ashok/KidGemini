# PRD — Motorcycle Assets (2026-08-06)

**Owner ask:** "There are no motor bikes. I want at least 10 types of
motorcycle meshes in the assets" — downloaded from the internet where possible
and wired properly into Ari.

**Shipped:** 13 motorcycle-family models, live on the asset host and in the
manifest/taxonomy/gallery/prompt catalog — plus a new platform capability this
batch forced into existence: **CC-BY 3.0 models with mechanical attribution**
(owner decision, same session: "we can provide attribution … but that has to be
wired properly, also informed to the kids when they are making").

| name | source | license | bytes |
|---|---|---|---|
| `sport_bike` | first-party | CC0 | 6.2 KB |
| `race_bike` | first-party | CC0 | 6.4 KB |
| `dirt_bike` | first-party | CC0 | 5.8 KB |
| `cruiser_bike` | first-party | CC0 | 6.2 KB |
| `chopper_bike` | first-party | CC0 | 6.2 KB |
| `police_bike` | first-party | CC0 | 6.9 KB |
| `scooter` | first-party | CC0 | 6.1 KB |
| `moped` | first-party | CC0 | 6.4 KB |
| `delivery_bike` | first-party | CC0 | 6.3 KB |
| `mini_bike` | first-party | CC0 | 5.4 KB |
| `motorcycle` | poly.pizza /m/j20srJUjpB (AliceCassie) | CC0 | 19.5 KB |
| `military_motorbike` | poly.pizza /m/9SwnIlPjNv (Zsky) | CC-BY 3.0 | 41.9 KB |
| `street_motorcycle` | poly.pizza /m/0lBe-ApqJs4 (jeremy) | CC-BY 3.0 | 31.5 KB |

## Tech Feasibility

**The sourcing sweep (2026-08-06).** ~30 search terms on poly.pizza
(motorcycle, motorbike, scooter, dirt bike, chopper, moped, sport bike, quad,
cruiser, superbike, cafe racer, motocross, vespa, harley, …), plus Kenney's
asset search, Quaternius' pack list, and OpenGameArt (CC0 + 3D filters):

- **CC0 pool: exactly ONE motorcycle** — "Cartoony Purple Motorcycle"
  (/m/j20srJUjpB). Every other two-wheeler on poly.pizza is CC-BY 3.0
  (including the entire Google-Poly archive).
- **Kenney:** no motorcycle in any kit (asset search returns nothing).
- **Quaternius:** the only "bike" tag is a bicycle in the public-transport pack.
- **OpenGameArt:** one CC0 hit ("fancy motorcycle"), but it's an untextured
  `.blend`/`.obj` — no GLB, unknown quality, would need a new conversion path.

So the ask was NOT satisfiable by download under the CC0-only policy — the
same situation as cricket (zero CC0) and Indian games (zero CC0). Two remedies
used together:

1. **First-party authoring** (the established cricket/Indian-games remedy):
   a parameterized motorcycle generator in
   `scripts/author-first-party-models.mjs` (shared skeleton: wheels on the X
   axle, fork/frame struts in the YZ plane, engine/tank/seat scaled to
   wheelbase; a step-through `scooterBase` variant for scooter/moped/delivery).
   Ten distinct silhouettes, flat-shaded vertex colors (the library's look),
   dedicated CC0 in `assets-src/LICENSE.md`.
2. **CC-BY 3.0 unlock** (owner decision this session) for the two best
   unbranded downloads. Feasible because attribution can be discharged
   *mechanically* — see Tech Plan.

**CC-BY candidates rejected at the thumbnail/probe pass** (recorded in
`scripts/vendor-models.mjs` so nobody re-adds them):

- Suzuki SV650 (/m/1yfyze7uGxS), Harley "Sportster" (/m/0CZY9yGxi6Y) — branded
  (§4.2 "nothing branded"); Vespa (/m/blGLclvvdEM) — brand-name design;
  Speeder Bike (/m/1hTD6Jy384m) — Star Wars fan art.
- Over the 150 KB budget with simplify() a no-op (flat-shaded, the documented
  tank_rusty class): scrambler_bike /m/bBbozwADWnS (508 KB), the Google-Poly
  cruiser /m/5_MTCnqfUTr and sport bike /m/dse64pqMKAR (~1 MB each).

**Scale normalization.** poly.pizza sources ship at author scale —
street_motorcycle measured **15.8 m** long, military_motorbike 5.2 m, the
purple motorcycle 1.04 m. New deterministic `normalizeLongest` option in
`vendor-models.mjs` bakes a uniform root-node scale (longest axis → given
metres) so the library keeps its real-world-size convention.

## Tech Plan

**Attribution, wired properly (all landed this change):**

1. **Schema** (`src/lib/assets/manifest.ts`): `license` union gains
   `"CC-BY-3.0"` — allowed for `model` entries ONLY (sfx/music stay CC0-only),
   and the validators REQUIRE a non-blank `author` on every CC-BY entry.
   `sourceUrl` doubles as the credit link target.
2. **In-game credits chip** (`runtime-helpers.ts` `creditsHelper` +
   `inject.ts`): any game whose *resolved* models include a CC-BY entry gets a
   small fixed "🎨 art" chip (bottom-left) that expands into the license's
   required credit lines — title, author, source link, license name. Injected
   mechanically at the same layer as `loadModel`, so the **preview shows it
   while the kid is making** (the "informed to the kids" ask) and every
   published copy carries it. Fails soft; no chip when the CC-BY model was
   dropped (unknown/budget) — a credit for absent art would be a lie.
3. **Prompt catalog** (`prompt-catalog.ts`): a manifest-derived clause names
   the community-art models and tells the LLM the platform adds the chip —
   never remove/hide/cover it, keep the corner clear. Manifest-derived =
   byte-stable per manifest, preserving the Gemini prefix-cache contract.
4. **Gallery** (`gallery.ts` + `src/app/assets/page.tsx`): CC-BY cards show
   "🎨 Art by <author> (CC BY 3.0) — your game will show this credit
   automatically", linking the source page.
5. **Pipeline** (`scripts/vendor-models.mjs`): per-model `license`/`author`
   fields flow into the manifest entry; `normalizeLongest` as above.

**Selection/curation wiring:** 13 `TAXONOMY` entries (racing primary; city /
nature / military secondaries; `motorbike`/`motorcycle`/`scooty` tags — no
brand words); racing genre trigger gains
motorcycle/motorbike/bike/scooter/scooty/moped/stunt/wheelie; 13 gallery
emojis; prompt-catalog token ceiling raised 2100 → 2300 (measured 2179 — 13
names + the license-required credit clause, not catalog creep).

**Tests** (all green, 399 asset-suite tests): validator accepts CC-BY model
with author / rejects without / rejects CC-BY sfx; chip present for a CC-BY
game, absent for CC0-only, absent when the CC-BY model dropped; taxonomy
coverage both directions; ceiling.

**Visual pass:** every model rendered via a headless-Chromium harness (repo
three.js + meshopt decoder, the compressed bytes) — each silhouette reads as
its type; mini_bike's engine rescale caught and fixed this way.

## Use Cases

1. **"Make me a 3d motorcycle racing game"** — racing trigger fires
   (motorcycle), catalog offers all 13; LLM picks e.g. `sport_bike` +
   `race_track_straight`/`race_track_curve`/`finish_line`. All-CC0 pick → no
   chip. *Tackled by:* trigger words + racing-genre taxonomy.
2. **"A dirt bike stunt game in the forest"** — `dirt_bike` is also in
   `nature`; knobby 8-segment wheels read off-road; stunt/wheelie trigger
   words route correctly. *Tackled by:* dirt_bike genres + trigger additions.
3. **"Police chasing a robber on bikes"** — `police_bike` (light bar,
   panniers, windshield) + `street_motorcycle`; the latter is CC-BY → the
   game auto-carries the "🎨 art" chip crediting jeremy; the kid sees the chip
   already in the chat preview. *Tackled by:* credits chip in inject.ts.
4. **"An army game with a motorbike messenger"** — `military_motorbike` lives
   in the military genre beside the tanks; chip credits Zsky. *Tackled by:*
   military+racing taxonomy entry.
5. **"Pizza delivery game"** — food trigger pulls the food set; "delivery"
   tag + racing/city genres surface `delivery_bike` (top-box read). *Tackled
   by:* delivery/courier/pizza tags.
6. **"Scooty game like mumma rides"** — `scooty` tag + trigger word (the
   word Indian kids actually use) → `scooter`/`moped`. *Tackled by:* tags +
   trigger.
7. **A kid browsing /assets** — 13 new cards with 🏍️/🛵 placeholders,
   spinning turntables, magic words ("3d dirt bikes"); CC-BY cards teach the
   credit up front. *Tackled by:* gallery emojis + credit line.
8. **A kid's game that mixes bikes with cars** — all bikes normalized to
   real-world length (1.9–2.3 m), so they sit correctly beside the 2 m Kenney
   cars without per-model scale surgery. *Tackled by:* `normalizeLongest`.
9. **Kid says "remove that art button"** — the prompt clause instructs the
   model the chip is license-required and platform-owned; regenerated HTML
   can't remove it anyway (re-injected on every serve). *Tackled by:* prompt
   clause + inject-on-serve.
10. **A future batch wants CC-BY audio** — validators refuse today
    (deliberate: the chip only covers models). Extend `creditsHelper` +
    validator together; this PRD is the pointer. *Tackled by:* explicit
    fail-closed rule + this note.

## Scale ceilings

- Prompt catalog measured ~2179/2300 tokens — the next sizeable batch should
  implement the category-map hybrid (headings static, names retrieved) the
  catalog doc promises, instead of another raise.
- The credits chip covers **models only**; audio stays CC0-only until the chip
  (and audio catalog) learn attribution.
- `normalizeLongest` is per-entry curation, not an automatic guard — a future
  batch should eyeball reported bbox sizes in the render pass (the dry run
  prints nothing about size; the render harness does).
