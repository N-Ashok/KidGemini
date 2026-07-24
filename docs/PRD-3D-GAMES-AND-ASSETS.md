# PRD — 3D & Audio Games: engine, immutable asset host, tiered access

**Status:** Decisions locked (2026-07-08); reviewed against both repos and
amended 2026-07-12 (citations, budgets, §10b risks, §9c UX). **Supersedes and
replaces `PRD-3D-GAMES.md`.** Parent product doc: `PRD.md` (F5 — game
artifacts). Cost lever registered as platform `TECH_DEBT` #33.

**The v1 decision that shapes this document:** we build the **end-state
directly** — a shared, immutable, versioned asset host
(`assets.ariantra.com`) that every game references by URL — instead of first
shipping base64-embedded assets and migrating later. Consequences, all
deliberate:

- Game HTML stays **tiny** (kilobytes): it references the engine, models,
  and audio by URL rather than carrying them.
- One `car.glb` serves a thousand games, and the **browser cache is shared
  across games** (all `*.ariantra.com` is one cache partition — the second
  3D game a kid opens loads its engine and models near-instantly).
- The price: the **immutability contract** (§10) sits on the critical path —
  it must be built, attacked by tests, and proven by a canary game **before
  the first kid's 3D game ships**.

**History:** Phase 0 (Three.js engine, embed-style) was built and reverted
the same day (commits `aa2cd33` + `c0966c2`, reverted in `cf391d5` +
`85db57c`). The
code returns adapted: the engine is now *served from the asset host*, not
embedded (§4), which structurally eliminates the failure class that bit
Phase 0 in production.

---

## 0. The constraint, restated for the end-state

Published games are **permanent and
self-consistent forever** (CloudFront/S3 static — see `ECOSYSTEM.md`,
`BUILD_PIPELINE_SPEC.md`). With URL-referenced assets, permanence is carried
by a **contract** instead of by embedding:

> **A game may reference only URLs that are guaranteed to outlive it.**
> Concretely: every referenced URL lives on `assets.ariantra.com`, is
> content-hash-named, append-only, never deleted, never overwritten, and
> enforced by policy + tests + a canary (§10–§12). Nothing else may ever be
> referenced — no CDN links, no third-party URLs, no mutable paths.

Everything a game needs at play time comes from exactly two origins, both
ours and both permanent: its own subdomain (`{slug}.ariantra.com`) and the
asset host (`assets.ariantra.com`).

**S3 roles, precisely:** `sites/{slug}/` = the game's own files;
`sites/assets/` = the shared immutable library (served AS
`assets.ariantra.com` by the existing CloudFront wildcard — zero new infra,
§10). The vendor pipeline's staging area and the bundle archive are
internal and never referenced by games.

---

## 1. Problem

Kids ask for "a racing game" or "a dino game" and get flat 2D canvas
rectangles with no sound. Three gaps:

1. **No 3D.** Real 3D (a road stretching into the distance) is a step-change
   in how impressive the result feels — but games must stay static,
   serverless, and permanent.
2. **No real assets.** Even with an engine, primitive boxes only go so far.
   Kids' games want a car, a dino, a tree — and a jump/coin/hit sound with a
   little background music. We need a large curated library of
   commercial-safe models and audio.
3. **No tiering.** 3D/audio generation is heavier (bigger prompt catalog,
   more cost). Paying users should get it seamlessly (**inbuilt**); free
   users should invoke it deliberately (**keywords** like "3d game") — which
   doubles as a cost-control lever.

## 2. Goals

1. The model builds genuinely 3D games (camera, lighting, depth) when the
   idea calls for it — 2D canvas stays the default.
2. A repeatable **download→curate→compress→publish-to-asset-host** pipeline
   for CC0 3D models and CC0/no-attribution audio, with a manifest and
   license proof per asset.
3. Games request **named** assets (`car`, `coin_pickup`, `bg_loop_upbeat`)
   and reference them by **immutable URL** — no runtime risk, no attribution
   burden, shared cache across games.
4. **Tiered access:** paying → inbuilt; free → keyword-invoked; the gate
   also controls whether the token-costly catalog enters the prompt.
5. Games run on ordinary kid hardware (phones, Chromebooks — no gaming GPU).
6. **Zero licensing risk:** CC0-only.
7. The immutability contract is **proven before it has a real dependent**.

## 3. Non-goals

- Kid-uploaded models/sounds (moderation surface; later).
- Textures/skyboxes/HDRIs from image files, physics engines, multiplayer.
- Third-party CDN references of any kind (the contract forbids them).
- Voice/TTS, licensed/branded music. Photorealism — the bar is "delightful
  low-poly", not AAA.
- Offline play of a *downloaded* HTML file (a saved .html plays fully when
  online — CORS `*` — but with no connection its 3D/audio won't load;
  in-Arcade play is cache-fast after first load — accepted trade).

---

# Part I — The engine (Phase 0, adapted to the asset host)

The reverted Phase-0 code returns with ONE structural change: the Three.js
bundle is **served, not embedded**.

- **Build (unchanged):** `scripts/vendor-three.mjs` bundles the `three` npm
  package with esbuild into one tree-shaken ES module — now **including
  GLTFLoader** (+~50 KB; and the meshopt decoder if we meshopt-compress
  models).
- **Publish (new):** the bundle uploads to the asset host as
  `three.{hash}.js` under the same contract as every other asset. An engine
  upgrade is a NEW file (`three.{newhash}.js`) referenced by *newly*
  generated games; old games keep their old engine forever — engine upgrades
  can never break a published game.
- **Injection (simplified):** when the model emits `<!--USES_THREE-->`, the
  injector inserts an import map pointing `three` at the bundle's URL —
  **string-only, no file reads, no base64**. The Phase-0 production failure
  (`readFileSync` of a bundle the deploy didn't ship → dead stream,
  BUG-FIX-LOG 2026-07-08) becomes structurally impossible: there is nothing
  to read.
- **Opt-in marker + curated import list (unchanged):** `<!--USES_THREE-->`;
  `CHILD_SYSTEM_PROMPT` lists primitive geometries, basic materials, lights,
  `PerspectiveCamera`, `WebGLRenderer`. Restore the `100dvh` sizing rule
  with it.
- **Cache dividend:** the ~550 KB engine downloads ONCE per kid device and
  serves every 3D game they ever open (shared `ariantra.com` cache
  partition, year-long immutable caching).

---

# Part II — The asset library

## 4. The gathering pipeline (build-time, on the dev machine)

`scripts/vendor-models.mjs` and `scripts/vendor-audio.mjs`, siblings of
`vendor-three.mjs`. All run **on the Mac at curation time** — never on the
box, never at runtime.

### 4.1 Sources — CC0-only (verified 2026-07-08)

**3D models (all CC0, commercial use, no attribution):**
- **Kenney.nl** — `https://kenney.nl/assets` (filter: 3D) — 40k+ CC0 game
  assets, consistent low-poly style. Primary.
- **Quaternius** — `https://quaternius.com` — large CC0 low-poly packs;
  mirrored at `https://poly.pizza/u/Quaternius` (1,400+ models, direct glTF
  download).
- **poly.pizza** — `https://poly.pizza/search/CC0` — aggregator; **must use
  its CC0 filter** (it also indexes CC-BY). Exports glTF directly, no login.
- Backup pools: `https://itch.io/game-assets/assets-cc0`, curated index
  `https://github.com/madjin/awesome-cc0` (verify license per pack).
- (Later, textures/images: **Poly Haven** `https://polyhaven.com`,
  **AmbientCG** `https://ambientcg.com` — both 100% CC0; out of scope v1.)

**Audio (no-attribution only):**
- **Kenney audio packs** — `https://kenney.nl/assets` (filter: Audio) —
  fully CC0. Primary for SFX.
- **Pixabay** — `https://pixabay.com/sound-effects/` and
  `https://pixabay.com/music/` — no-attribution, commercial OK, MP3.
- **OpenGameArt** — `https://opengameart.org` (license filter = CC0) and
  **Freesound** — `https://freesound.org` (license filter = CC0) — per-clip
  license varies → the pipeline records and verifies the CC0 tag per file
  and rejects anything else.

**Explicitly avoid** (attribution or non-commercial): Mixkit, Zapsplat
non-premium, BBC RemArc, Jamendo commercial, CC-BY/CC-BY-NC anything.

### 4.2 Curation criteria
- Kid-friendly subject; nothing scary/violent/branded.
- **Models:** low-poly (< ~5K tris), reads well untextured (baked vertex
  colors OK), looks good from a game camera.
- **Audio:** short, loud enough, clean; music loops seamlessly (seamlessness
  is delivered by the Web-Audio `playMusic` helper, not the MP3 file — §10b R2).

### 4.3 Normalize / compress / name
- **Models → GLB**, `gltfpack`/meshopt-compressed, **≤ 100 KB**.
- **Audio → MP3** (iOS-safe; OGG rejected), mono, 96–128 kbps; SFX
  **≤ 30 KB**, music loop ≤ 30 s, **≤ 400 KB** (aim ~200).
- **Every file is content-hash-named at birth:** `car.a3f8c2.glb`,
  `coin_pickup.91be04.mp3`, `three.7cc1d9.js`. The name IS the integrity
  check and the immutability mechanism — changed bytes = new name, so
  overwrite is meaningless, not merely forbidden.

### 4.4 Publish to the asset host + manifest
```
s3 sites/assets/            ← served as https://assets.ariantra.com/…
  three.7cc1d9.js
  car.a3f8c2.glb  tree.5d21aa.glb  …
  coin_pickup.91be04.mp3  bg_loop_upbeat.cc03f1.mp3  …
```
Upload sets `Cache-Control: public, max-age=31536000, immutable` (safe ONLY
because of hash naming) — per BUG_LOG #6, the uploader always states cache
policy explicitly.

**`manifest.json` ships IN-REPO** (small JSON: `name`, `type`
(model|sfx|music|engine), `url`, `bytes`, `license`, `sourceUrl`,
`sha256`). `license` is `"CC0"` for every library asset; the ONE exception
(found at implementation, 2026-07-12) is the engine itself — three.js is
**MIT**, so the `engine` entry carries `license: "MIT"` and the vendor
script preserves three's license notice inside the served bundle (esbuild
`legalComments: 'inline'`), which satisfies MIT's notice requirement.
`src/lib/assets/manifest.ts` enforces CC0-only for model/sfx/music. In-repo because the injector and the prompt catalog both read it,
it must version-lock with `CHILD_SYSTEM_PROMPT` (prompt-contract test), and
it's the ONLY thing the box needs — **there is no box-side asset cache and
no `sync:assets` step in this design.** The pipeline refuses to add a
manifest entry unless the URL already resolves publicly (upload-then-verify,
never trust-then-404).

### 4.5 Starter set
- **Models (first 5: car, dino, tree, coin, rocket → fill to ~12–20):**
  airplane, boat, dog, cat, fish, castle tower, robot.
- **SFX (~10–15):** jump, coin/pickup, hit/hurt, explosion, click/UI,
  powerup, game-over, win/level-up, laser/shoot, engine/whoosh.
- **Music (~3–5 loops):** upbeat, chill, tense, victory jingle, menu.

---

# Part III — Generation, serving, client

## 5. The content ladder — the library is an upgrade, never a dependency

The model can ALWAYS generate a complete game's content itself, inline:
canvas-drawn sprites, CSS art, inline SVG, procedural Three.js geometry,
Web Audio–synthesized sound (oscillator code — no file at all). That is
today's product and it stays ungated on every tier. The new machinery sits
on top:

| Rung | Content | Gate |
|---|---|---|
| 1 | **Model-generated inline** (drawn/synthesized in code) | none — always, every tier |
| 2 | **Engine** (real 3D via Three.js) | the `USES_THREE` marker only (550 KB injected only when 3D is wanted) |
| 3 | **Library assets** (curated models + recorded audio) | tier/keyword (Part IV) |

Consequences:
- **Gates control library access and prompt guidance — never coding
  ability.** A free kid asking for "a platformer with jumping sounds" and no
  magic words can still get sound: Gemini writes Web Audio synthesis inline.
  The audio keyword unlocks the curated MP3 catalog, not the concept of sound.
- **Fail-soft has a floor:** a library asset that fails to load degrades the
  game toward rung 1 (entity absent, or a synthesized fallback) — never
  toward a broken page.
- The tiering pitch is honest: paying (or keyword-invoking) buys *curated
  quality* — a good dino instead of a code-drawn one — not basic capability.

## 5b. Using library assets at generation time

- The system prompt teaches a **named catalog** (only when injected, Part
  IV). The model requests assets with markers:
  - `<!--USES_THREE-->` · `<!--USES_MODELS: car,tree-->` ·
    `<!--USES_AUDIO: coin_pickup,jump,bg_loop_upbeat-->`
- The model writes against tiny helpers: `loadModel("car")` (GLTFLoader on
  the asset URL), `playSound("coin_pickup")` / `playMusic("bg_loop_upbeat")`.
- The **injector** maps marker names → manifest URLs and inserts: the import
  map (engine URL), a small `AR_ASSETS = {car: "https://assets…/car.a3f8c2.glb", …}`
  table, and the helper script. **String concatenation only — the injector
  never reads asset bytes and never touches the network.** Unknown names are
  dropped from the table (fail-soft) and logged.
- **Safety scan runs on the model's raw output BEFORE injection** — unchanged
  from Phase 0.
- **Runtime fail-soft:** helpers wrap fetch/decode in try/catch — a failed
  model load leaves the game running (that entity absent), a failed sound is
  silent. A game must never white-screen because one asset hiccuped.
- **Publish records the reference ledger:** the list of asset URLs a game
  references is stored on the game doc at publish (the injector already
  knows it from the markers). "Forever" becomes an enumerable, testable set
  (§11 ledger test).

## 6. What runs where, when (the lifecycle map)

```
 ①  DEV MACHINE (Mac)               — curation time (occasional, human-run)
 │    vendor-three/models/audio.mjs: download (Kenney/Quaternius/poly.pizza/
 │    Pixabay) → curate → compress → hash-name → upload to asset host with
 │    immutable headers → verify URL resolves → commit manifest.json to repo
 ▼
 ②  ASSET HOST (assets.ariantra.com — CloudFront → S3 sites/assets/)
 │    — at rest, append-only, forever. Nothing executes here.
 ▼
 ③  EC2 BOX (kidgemini, :3001)      — generation time (each build turn)
 │    tier/keyword gate → catalog into prompt → Gemini writes the game
 │    → safety scan → injector inserts URLs + helpers (string concat ONLY —
 │    no file reads, no network, no asset bytes on the box at all)
 │    → tiny HTML streams to the kid
 ▼
 ④  KID'S BROWSER                   — play time
 │    fetches engine/models/sounds from the asset host on FIRST load;
 │    immutable year-long cache + shared ariantra.com partition means the
 │    next 3D game (any game) reuses them — near-instant
 ▼
 ⑤  CLOUDFRONT/S3 sites/{slug}/     — published game, forever
      tiny HTML referencing URLs the contract guarantees outlive it
```

**Constraints per machine:**

| Machine | Constraint | Why it holds |
|---|---|---|
| ① Dev Mac | Needs `gltfpack`, `ffmpeg` (one-time); human-run batch job, re-runnable per asset | All heavy work (download/transcode/compress) happens only here |
| ② Asset host | Append-only + immutable by policy and naming; single point of failure → must be boring: CloudFront, immutable headers, CORS `*` (public CC0 files), standing smoke check (§11) | One misconfig here breaks every 3D game at once — the standing `curl -I` check (BUG_LOG #9's prevention rule; see also #5) applies permanently |
| ③ EC2 box (1 GB, shared) | **Zero asset bytes, zero new processes, no memory-budget change** (`MEMORY_BUDGET.md`); needs only the in-repo manifest | Simpler than the box has ever been — the end-state REMOVED a moving part (no cache, no sync) |
| ④ Browser | First-load transfer + render budgets (§7–8) on kid hardware incl. old phones | The budgets ARE the client constraint |
| ⑤ CloudFront | Game files permanent; referenced URLs contract-guaranteed | The contract replaces embedding as the permanence mechanism |

The invariant: **the internet is touched at ① by a human, and at ④ by the
kid's browser against our two permanent origins. The box touches neither.**

## 7. Client hardware: GPU and how much 3D can run

The game renders entirely in the **kid's browser** — our servers never draw
a frame.

### GPU requirement: none dedicated — any WebGL device
- Three.js renders via **WebGL** — hardware-accelerated on every mainstream
  device of the last ~10 years: phone GPUs (Apple, Adreno, Mali), integrated
  laptop graphics (Intel UHD/Iris, Apple Silicon), school Chromebooks.
  Support is effectively universal (~97%+ of devices in use).
- **No discrete/gaming GPU, ever.** Untextured low-poly (<5K tris/model),
  basic materials, no shadows, no post-processing — orders of magnitude
  below what a 2015 phone handles at 60 fps.
- **Design floor:** ~2018 budget Android / entry Chromebook. Runs there →
  runs everywhere above.
- **Fallback:** WebGL unavailable → the helper shows a friendly "this game
  needs 3D — try another browser/device" message, never a blank canvas.

### Render budget (60 fps target on the floor device; 30 acceptable)

| Metric | Budget | In practice |
|---|---|---|
| Triangles on screen | **≤ 100K/frame** | ≤5K-tri models → **~20 instances** visible comfortably; with `InstancedMesh` (50 copies of one tree), far more |
| Draw calls | **≤ 100/frame** | Distinct object ≈ 1 call; instance repeated scenery |
| Distinct models/game | **≤ 3–5** (first-load budget, §8) | Network limits *variety*; GPU limits *totals* |
| Lights | ≤ 2 (directional + ambient) | Per-light cost multiplies shading |
| Pixel ratio | cap at **2** | Stops 3× retina phones rendering 9× pixels |
| Forbidden | shadows, post-processing, heavy transparency | The classic mobile-WebGL frame-killers |

Enforced by (1) rules in `CHILD_SYSTEM_PROMPT`'s 3D section and (2) a
prompt-contract test asserting they're present. No runtime fps-governor in
v1 — revisit only on real-device jank in Mixpanel.

## 8. Budgets (first-load transfer is the new constraint)

Under embedding, a game's practical size was bounded by the publish bundle
limits (5 MB/file, 30 MB/bundle — platform `src/lib/publish/bundle.ts`) and
the 24576-token generation output budget. URLs make **first-load transfer**
the binding constraint instead (cold cache, school Wi-Fi / mobile data).
Per-asset budgets stay (they're now download budgets); the per-game cap
becomes a transfer cap:

| Thing | Budget | Enforced by |
|---|---|---|
| Engine (`three.{hash}.js`, incl. GLTFLoader) | ~550 KB, one-time per device, then cached across ALL games | bundle test |
| Per model (GLB) | ≤ 100 KB | manifest test |
| Per SFX | ≤ 30 KB | manifest test |
| Per music loop | ≤ 400 KB (aim ~200) | manifest test |
| Per-game audio total | ≤ 500 KB | inject-time check |
| **Per-game first-load transfer** (engine + referenced assets, cold cache) | **≤ 2 MB** | inject-time check (sums manifest `bytes`) |
| Game HTML itself | tiny (~tens of KB) — no cap needed | — |
| Prompt catalog | hard cap 30 models (25 → 30, owner decision 2026-07-13) + ~15 audio in-prompt; beyond → retrieval step | prompt-contract test |
| 1 GB EC2 box | no asset bytes, no new processes, **no memory-budget change** | — |

Worst case ≈ 550 + 3×100 + 500 ≈ **1.35 MB cold**, and the engine (the
biggest piece) is usually already cached from any earlier 3D game — typical
incremental load is a few hundred KB. Strictly better than embedding, where
every game re-shipped all 1.35 MB inside its HTML.

---

# Part IV — Tiered access

## 9. Paid = inbuilt · free = keyword-invoked

- **Paying user:** 3D + audio catalog always available; the model uses it
  whenever the idea fits ("racing game" → 3D + engine SFX).
- **Free user:** unlocks on triggers. 3D: the token **"3d"** ("3d game",
  "3d racing", "3d world"…). Audio: **"sound", "music", "sound effects",
  "with sound/music"**. Cheap server-side regex before prompt build — no LLM
  call. Err toward unlocking: a false unlock costs a few catalog tokens; an
  under-unlock is a bad kid experience.

**The cost lever (`TECH_DEBT` #33):** the catalog costs ~15–20 prompt
tokens/asset, so injection nests under a **"build-a-game turn?"** gate —
chit-chat never carries it — and **3D and audio gate independently** (a 2D
"platformer with sound" gets SFX, no 3D):

```
incoming message
  └─ build-a-game turn?   (chit-chat → normal prompt, zero catalog tokens)
       ├─ paid user                              ──► 3D catalog + audio catalog
       └─ free user → keyword scan:
            ├─ 3D trigger    ("3d", …)           ──► 3D catalog
            └─ audio trigger ("sound/music", …)  ──► audio catalog
```

**Sequencing (locked): keyword-for-all now; always-on-for-paid as a fast
follow.** Paid entitlement is unbuilt (`TECH_DEBT` #11 — no
`entitlement(userId)` against Razorpay `periodEndsAt`); blocking on it delays
everything for a one-line gate change. When entitlement lands, the paid
branch simply returns true.

## 9b. The asset gallery — kids can SEE the library

Without this, the catalog exists only inside the system prompt — invisible
to the one audience it's for. A kid who doesn't know the dino exists never
asks for a dino game.

**`kidgemini.ariantra.com/assets` ("Game Stuff"):** a static kidgemini page
rendered straight from the in-repo `manifest.json` — zero backend, zero new
data:

- **Models:** live 3D turntable per card, rendered by loading
  `three.{hash}.js` **from the asset host itself** — the gallery permanently
  dogfoods the contract (if the gallery renders, the host works; it joins
  UAT as the human-visible smoke check).
- **Sounds/music:** ▶ play button per clip (they're already public MP3 URLs).
- **Each card teaches the trigger:** "Say *'make a 3d dino game'* to use
  this!" — the gallery doubles as the free tier's keyword tutorial and the
  advertisement for the capability (and later, the paid tier's always-on).
- **Everyone sees everything** (free included): seeing costs nothing;
  building is what's gated. This also answers "what models do you have?"
  as a link instead of forcing catalog tokens into an ungated chat turn.
- Grows automatically: new manifest entry → new card, no page work.

## 9c. UX (locked with the reviewed mock)

Reviewed mock: the kid journey is three moments of new experience, almost
zero new UI.

- **(a) Magic words taught, never locks.** Free-tier "3d"/"sound" triggers
  are taught by a **one-time buddy tip bubble** ("Psst — say '3d' to open
  the 3D toy box!") and by the gallery. The app never shows a lock icon and
  never refuses: a non-keyword ask builds the ungated rung-1 version (§5
  content ladder) exactly as today.
- **(b) One new loading state.** "Getting the 3D toy box ready…" with a
  progress bar, shown **only on the first engine load per device** (the
  ~550 KB fetch); every later 3D game loads from cache with no special
  state. Words, never a bare spinner; never twice.
- **(c) The "Game Stuff" gallery (§9b).** Live 3D turntable cards + playable
  sound cards; each card teaches its trigger phrase with a **read-aloud
  button** for pre-readers (voice on request, not auto — the Idea Button
  coach UAT established auto voice-over reads as intrusive). Zero backend;
  rendered from the in-repo manifest.
- **(d) Fail-soft UX rules.** Model load failure → entity absent, game keeps
  running; sound failure → silent effect; no WebGL → friendly "this game
  needs 3D — try another browser or device" card, never a blank canvas;
  saved-to-disk .html opened offline → gentle "connect to the internet to
  load the 3D stuff" line (Decision L, honest).
- **(e) Paid tier framing.** No magic words to learn — "the toy box is
  always open" (lands with entitlement, §9 sequencing); the absence of
  friction is the feature.

---

# Part V — The contract, testing, rollout

## 10. The immutability contract (what makes URL-references safe forever)

1. **Append-only, immutable, forever.** Content-hash filenames; NEVER
   delete, NEVER overwrite. A better car ships as a new hash while the old
   file stays up eternally, because 2026's games point at it. Engine
   upgrades likewise (§Part I).
2. **Single point of failure → must be boring.** Served by the existing
   CloudFront wildcard from `sites/assets/` (zero new infra); immutable
   Cache-Control; **standing post-deploy smoke** on a known asset URL
   (the standing `curl -I` check — BUG_LOG #9's prevention rule, see also
   #5 — permanent).
3. **Deny-delete policy** on the prefix (`s3:DeleteObject` denied) — needs
   MarksZen owner coordination (borrowed bucket). S3 Object Lock NOT needed:
   hash-naming + policy + tests give the guarantee without bucket-level
   machinery we don't control.
4. **CORS: `Access-Control-Allow-Origin: *`.** The assets are public CC0 —
   restricting origins protects nothing and breaks legitimate cases (a
   saved-to-disk game file has origin `null`; module-script and GLB fetches
   would fail even online). `*` lets games fetch from any subdomain AND lets
   a saved file play whenever the kid is online. **Note: CORS is bucket-level
   configuration on the borrowed bucket — like the deny-delete policy (item
   3), it's a MarksZen owner-coordination item.** Alternative that avoids
   touching the bucket: a CloudFront **Response Headers Policy** on the
   wildcard distribution emits the header at the edge (sufficient for our
   simple GETs — GLB/MP3/module fetches — though it doesn't handle
   preflight). **Amendment (2026-07-12, learned in production):** the header
   must be **unconditional**. The managed `SimpleCORS` policy is conditional
   on the request's `Origin` header, and a conditional header on immutable
   year-cached objects let a propagation race poison a browser cache for a
   year; CloudFront also refuses `Access-Control-Allow-Origin` in a policy's
   custom-headers section. The working mechanism (deployed): a **CloudFront
   Function on viewer-response** (`ariantra-unconditional-cors`) assigning
   the header on every response — see kidgemini BUG-FIX-LOG 2026-07-12. The
   standing smoke checks the no-Origin variant too.
5. **Reserve the label FIRST:** `assets` → `RESERVED_LABELS` (`tenancy.ts`)
   so no game can ever claim the slug. The only irreversible race in the
   plan — it lands in the very first commit.

## 10b. Known technical risks (must resolve in the phase named)

**R1 — Self-healing preview vs WebGL (resolve in Phase B; hard gate).**
kidgemini's verify probe (`src/lib/preview-verify.ts`, `snapshot()`)
pixel-diffs the biggest canvas via drawImage → getImageData. A Three.js
`WebGLRenderer` with the default `preserveDrawingBuffer: false` reads back
**blank** after the frame is presented → constant hash → healthy 3D games
verdict "static" → false repair loop (exactly the failure class §8.1 of
PRD-SELF-HEALING-PREVIEW guards against). **Mitigation (preferred):** the
`CHILD_SYSTEM_PROMPT` 3D section requires the renderer be constructed with
`preserveDrawingBuffer: true` (negligible cost at our poly budgets), pinned
by the prompt-contract test. **Fallback:** exempt `USES_THREE` games from
the pixel probe via `src/lib/verify-policy.ts` (treat as inconclusive, like
the tainted-canvas case). Phase B exit criteria include: a real 3D game
passes self-healing verify with no false repair.

**R2 — MP3 music loops are not gapless.** MP3 encoders add priming/padding
samples, so `<audio loop>` produces an audible gap/click at every loop
restart. The `playMusic` helper (Phase D) must decode via Web Audio
(`decodeAudioData`) and loop an `AudioBufferSourceNode` with trimmed
`loopStart`/`loopEnd`; `playSound` can stay simple. §4.3's "music loops
seamlessly" is delivered by the helper, not by the file.

## 11. Testing contract (test-first, per repo rules)

**Contract tests (attack it, don't just read config):**
- Delete attempt on a canary object with app creds → `AccessDenied`.
- Hash-mismatched upload → pipeline refuses.
- Serving smoke: known asset URL → 200, `via: cloudfront`, immutable
  Cache-Control, CORS header. Post-deploy, standing.
- **Ledger test:** HEAD every URL any published game references → all 200.
  Post-deploy, forever.
- **Canary game:** one INTERNAL published game referencing a canary asset
  rides several normal deploys unattended BEFORE any kid game references
  anything (§12 Phase A gate).

**Feature tests:**
- Manifest/budget: every entry ≤ its size budget, valid magic bytes (GLB
  header / MP3 frame), `license == "CC0"` + `sourceUrl`, **and its URL
  resolves publicly**.
- Injection (extend `three-vendor.test.ts`): unmarked games pass through
  byte-identical; markers produce exactly the requested URL table; unknown
  names dropped fail-soft; injector performs zero file/network I/O
  (structural assertion).
- Prompt-contract (restore `gemini.test.ts`): catalog names ==
  manifest names; §7 render rules present; the
  `preserveDrawingBuffer: true` renderer rule present (§10b R1).
- Verify-policy: if the R1 fallback is used, a test that `USES_THREE` games
  treat the pixel probe as inconclusive rather than failing.
- Tier/keyword: paid → injected; free+keyword → injected; free+no-keyword →
  not; non-build turns → never.
- First-load budget: inject-time sum of referenced `bytes` ≤ 2 MB.

## 12. Rollout (contract first — it gates everything)

1. **Phase A — the contract + engine on the host** *(the critical path)*:
   reserve `assets` label; CORS + deny-delete + headers; `vendor-three.mjs`
   adapted to hash-name/upload/verify; manifest in-repo; contract tests;
   **canary game published and riding deploys**. Exit gate: canary green
   across ≥2 normal deploys, all contract tests standing in post-deploy smoke.

   *Progress (2026-07-12):* code side built and green — `assets` in the
   platform's `RESERVED_LABELS` (+ squatter test); `src/lib/assets/manifest.{ts,json}`
   with 22 contract tests (budgets, hash-naming, CC0-only, magic bytes);
   `scripts/vendor-three.mjs` (build→hash-name→upload→public-verify→manifest,
   559 KB incl. GLTFLoader, refuses on any mismatch);
   `scripts/assets-contract-check.mjs` (serving smoke wired into
   `deploy-rsync.sh` as a standing post-deploy check + `--attack`
   delete-attempt canary test). `assets.ariantra.com` confirmed resolving
   through the CloudFront wildcard. **Engine UPLOADED and verified 2026-07-12**
   (`three.b4a9d4.js`, 559 KB — 200 + immutable + sha256 match through the
   public path); manifest carries its entry. Side-find: studio-policy's
   reserved-slug list had drifted from tenancy's (a creator could claim
   `assets` and publish INTO the asset prefix) — fixed, platform BUG_LOG #13.
   **All contract items landed and PROVEN same day:** unconditional CORS via
   viewer-response CloudFront Function (after the SimpleCORS cache-poisoning
   incident, BUG-FIX-LOG 2026-07-12); deny-delete bucket policy applied by
   the MarksZen owner and attack-tested (`--attack` → AccessDenied, canary
   restored-and-serving); canary game live at canary-3d.ariantra.com with a
   real-browser PASS. **Sole remaining exit-gate item: the canary rides ≥2
   normal deploys** (standing smoke in deploy-rsync.sh does this
   automatically).
2. **Phase B — Phase-0 re-introduction on the new base:** restore the
   `gemini.ts` 3D prompt additions (incl. `100dvh`) and the chat-route
   injection, now URL-based (adapt the `aa2cd33`/`c0966c2` cherry-pick — the
   try/catch fallback stays as belt-and-braces even though the read it
   guarded no longer exists). Resolve §10b R1 (preserveDrawingBuffer prompt
   rule + tests). UAT: kid-visible 3D primitives games. Exit criteria: a
   real 3D game passes self-healing verify with no false repair.

   *Progress (2026-07-12):* built and green. `src/lib/assets/inject.ts`
   (string-only injector: `USES_THREE` → import map on the engine's
   manifest URL; unmarked byte-identical; zero-I/O structurally asserted) +
   `src/lib/assets/prompt-catalog.ts` (3D section: curated import list
   lockstep-tested against `vendor-three.mjs` exports,
   `preserveDrawingBuffer: true`, §7 render budgets) — the section rides
   only game-BUILD turns (`buildTurnSystemInstruction`, gemini.ts). Route
   injection carries the c0966c2 serve-raw-on-failure contract (tests
   P.1–P.3). The revert-lost `100dvh` fix was rediscovered and restored
   (BUG-FIX-LOG 2026-07-12). **R1 proven in a real browser** (harness:
   real injector + real verify probe + real classifier, engine fetched
   live from assets.ariantra.com): `preserveDrawingBuffer: true` →
   verdict `clean`; control with `false` → `canvas_static`, confirming
   the class. Remaining: kid-visible UAT.
3. **Phase C — models:** `vendor-models.mjs`, first 5 (car, dino, tree,
   coin, rocket), GLTFLoader in the engine bundle, `loadModel` helper +
   `USES_MODELS`. **Ships with the asset gallery (§9b)** — models arrive
   visible, and the gallery becomes the standing human smoke check. UAT.

   *Progress (2026-07-12):* built and green. `scripts/vendor-models.mjs`
   (pinned CC0 sources: Kenney car/platformer kits + poly.pizza CC0-checked
   model pages as the proof trail; gltf-transform + meshoptimizer
   `dedup→prune→resample→meshopt(high)` — NOT gltfpack, whose WASM build
   shipped white models, BUG-FIX-LOG 2026-07-12; upload-then-verify like
   the engine script). Staged set: car 33 KB, dino 89 KB (Quaternius
   Velociraptor, Run/Idle/Attack clips kept), tree 21 KB, coin 15 KB,
   rocket 16 KB.
   Engine bundle regrown with MeshoptDecoder + AnimationMixer + Box3
   (594 KB — engine budget raised 600→650 KB; worst-case first load
   ≈ 1.4 MB, §8 cap holds); `three.07fb80.js` staged. Injector handles
   `USES_MODELS` (AR_ASSETS table + fail-soft loadModel helper wiring the
   meshopt decoder; models imply the import map; unknown names + first-load
   overflow drop fail-soft and are logged). Prompt model catalog is
   GENERATED from the manifest (`modelsPromptSection` — name lockstep by
   construction; teaches background `.then` loading so the loop still
   starts synchronously, null fail-soft, AnimationMixer). Gallery live at
   `/assets` (single shared WebGL renderer blitted per card, emoji
   placeholder until first frame, read-aloud trigger phrases per §9c,
   friendly empty state, JSON-LD + sitemap/robots added). **Proven in real
   Chromium against the staged files**: dino+car load (6 anims), unknown
   name drops at inject AND nulls at runtime, verify verdict clean, zero
   console errors. Remaining: human-run `vendor-three.mjs --upload` +
   `vendor-models.mjs --upload` (manifest entries land then), gallery
   card visual pass + kid UAT after upload.
4. **Phase D — audio:** `vendor-audio.mjs`, ~10 SFX + 3 loops,
   `playSound`/`playMusic` + `USES_AUDIO`, audio + first-load budgets. UAT.

   *Progress (2026-07-12):* built and green. `scripts/vendor-audio.mjs`
   (Kenney audio packs CC0 for the 10 SFX — jump, coin_pickup, hit,
   explosion, click, powerup, game_over, win, laser, whoosh (trimmed
   1.2 s) — + OpenGameArt CC0 pages for the loops; ffmpeg-static → MP3
   mono 96 kbps; music duration ≤ 30 s enforced). Staged set: SFX 1.9–15 KB
   each; bg_loop_upbeat 243 KB/20.7 s, bg_loop_chill 228 KB/19.4 s,
   jingle_win 13 KB (Kenney jingles are ~1 s stingers — one-shot, not
   looped). Injector handles `USES_AUDIO` (no engine needed — 2D games get
   sound; shared AR_ASSETS table; per-game audio ≤ 500 KB AND first-load
   ≤ 2 MB enforced by fail-soft drops). §10b R2 resolved as specified: the
   injected playMusic helper decodes via Web Audio and loops an
   AudioBufferSourceNode between silence-trimmed loopStart/loopEnd — never
   an <audio loop> element; playSound is buffer one-shots; the context
   resumes on first tap (autoplay rule). Audio prompt catalog generated
   from the manifest (lockstep by construction). Gallery sound cards render
   automatically once entries land. **Proven in real Chromium**: both
   staged files fetch + decode, unknown name warns-and-silences, verdict
   clean, zero errors. Remaining: human-run `vendor-audio.mjs --upload`;
   kid UAT ("make me a game with sound").
5. **Phase E — tiering:** build-turn gate + keyword detection +
   catalog-injection gate (keyword-for-all); paid always-on when
   entitlement (`TECH_DEBT` #11) lands.

   *Progress (2026-07-12):* built and green. `src/lib/assets/catalog-gate.ts`
   (`catalogGates` — pure regex, no I/O): the §9 decision tree exactly —
   build-turn gate first (chit-chat pays zero catalog tokens), then paid →
   both catalogs, free → independent keyword scans (`\b3d\b`;
   `\b(sounds?|music|songs?|sfx)\b`) over the message AND the child's prior
   messages AND prior artifactHtml (`USES_*` markers survive in the
   artifact, so iteration turns keep the catalog the game was built with —
   err-toward-unlocking as specified). `buildTurnSystemInstruction(gates)`
   assembles only the unlocked sections; both-closed returns the bare child
   prompt byte-identical (free + no keyword ≡ today's product, §5 ladder).
   `configFor` hardwires `paid: false` until entitlement (`TECH_DEBT` #11)
   lands — then it passes the real entitlement and paid goes always-on
   (the one-line change as sequenced). §11 matrix tested
   (catalog-gate.test.ts, 12 tests + gated buildTurnSystemInstruction
   pins). Remaining: kid UAT.
6. **Phase F — fill out** to ~20 models, per-genre prompt hints. UAT.

   *Progress (2026-07-12):* built and green. Library grown 5 → 20 models in
   `vendor-models.mjs`: +dog (Quaternius Pug, animated), cat, fish
   (Clownfish, swim clips), boat, robot (Robot Enemy, 4 clips), tower,
   spaceship, ufo, ghost (all poly.pizza, CC0-checked by scripted page
   scan), helicopter (kazuma), ufo (hat_my_guy), + police, firetruck,
   star, key, chest (Kenney kits already in cache). Every candidate was
   size-probed through the exact pipeline transform BEFORE pinning;
   rejected over-budget even fully clip-trimmed: Shiba ~241 KB, Husky
   ~266 KB, both horses ~305 KB, two robot alternates (mesh-heavy —
   simplify() no-ops on skinned meshes). No CC0 fixed-wing airplane
   surfaced; flying = helicopter + spaceship + ufo + rocket.
   keepAnimations matching tightened to segment-exact ('Idle' no longer
   drags in Idle_2/Jump_ToIdle — bare substring blew the dog budget).
   All 20 staged ≤ 100 KB (largest: robot 95.2 KB); existing five hashes
   unchanged (deterministic pipeline). Per-genre prompt hints added to
   `modelsPromptSection` (racing/platformer/space/animals/castle/water),
   each line filtered to manifest names — a hint can never teach a
   missing model; genres with nothing available disappear (tested).
   Gallery emoji map covers all 20 (lockstep test vs vendor-models.mjs
   names); "3d police" plural fix. §14 cap 25 holds (20 in-manifest).
   **Proven in real Chromium** (staged files, real injector): dog (2
   anims), robot (4 anims), tower load and render textured; unknown name
   nulls; verdict clean, zero errors. Remaining: human-run
   `vendor-models.mjs --upload`; gallery visual pass + kid UAT.

   *Amendment (2026-07-13):* the 20 uploaded and live. Owner asked for
   cities/forest/aliens/animals → **7 more curated (→ 27 total)**:
   skyscraper (Kenney city-kit-commercial), house (city-kit-suburban),
   pine (platformer-kit), rock (nature-kit, older "GLTF format" layout,
   vertex-colored), alien 35.7 KB / bird 20 KB / shark 23.8 KB (Quaternius,
   CC0-checked pages). Prompt cap raised 25 → 30 (§14, owner decision) —
   past 30 the retrieval step remains the locked next move. New genre
   hints: city, forest/nature; shark/alien/bird joined existing genres.
   Rejected over-budget: Quaternius Deer ~260 KB, Fox ~263 KB, 2 alien
   alternates. **No CC0 fixed-wing airplane/fighter jet exists** on
   poly.pizza or Kenney (8 search terms tried) — flying stays
   spaceship/helicopter/ufo/rocket; revisit with a new source.
   Gallery turntable now plays the LIVELIEST clip (gallop/run/swim/fly/
   walk/jump/attack) instead of clip[0] — files often list a subtle Idle
   (or Death!) first, which read as statues (owner report 2026-07-13).
   Real-Chromium proof: skyscraper/alien(4 anims)/shark(1)/rock render
   textured, verdict clean. Remaining: human-run `vendor-models.mjs
   --upload` (the 7); gallery visual pass + kid UAT.

   **Gap found 2026-07-15 (owner report: dino "runs" by hopping/attacking,
   not alternating legs):** the liveliest-clip fix above was applied to the
   internal gallery preview ONLY — the actual game-generation prompt
   (`src/lib/assets/prompt-catalog.ts`'s `modelsPromptSection`) still taught
   the raw `m.animations[0]` pattern, unchanged since Phase C. For the dino
   specifically, clip order is `[Attack, Idle, Run]` — index 0 is a pounce,
   which reads as "both legs together" exactly like the report. Note the
   gallery's OWN liveliest-clip regex (`/gallop|run|swim|fly|walk|jump|
   attack/i`) would ALSO have picked Attack here (it's a plain
   `.filter(...)[0]` over array order, and "attack" matches the same
   regex before "run" appears) — it never actually solved "pick the RIGHT
   action," only "don't look frozen," which happened to be good enough for
   a turntable but not for gameplay. Fixed by teaching Gemini to search by
   name, preferring `run|walk` specifically, before falling back to other
   lively clips, before falling back to `animations[0]` as a last resort —
   see `prompt-catalog.ts` §5 of the models section, tested in
   `prompt-catalog.test.ts`. No procedural bone/leg-IK animation exists or
   is taught anywhere in this system — all character motion is baked
   mocap clips selected at runtime, never generated by the AI.

   *Amendment 2 (2026-07-13, owner: "at least 50 models"):* **retrieval-lite
   built** (`model-select.ts`, §14 updated): manifest unbounded, each prompt
   teaches ≤ 30 models — priority: iterated game's own `USES_MODELS` >
   explicit name mentions > genre keyword matches > core set; libraries
   ≤ 30 skip selection (behavior unchanged below scale). Genre → models
   data is one source of truth for selection AND the prompt hint lines.
   **Library filled 27 → 50:** hero (platformer-kit character), heart, gem,
   bomb, spring, flag, mushroom, barrel, crate (platformer-kit); taxi,
   ambulance, tractor (car-kit); catapult, bridge (castle-kit); burger,
   ice_cream, donut, apple (food-kit); chicken 36.8 KB, bat 71.7 KB,
   dolphin 22.2 KB, bee 50.5 KB, sword 15.9 KB (poly.pizza Quaternius,
   CC0-checked + probed). Rejected over-budget: Penguin ~154 KB, Panda
   ~177 KB, Bunny ~154 KB, Turtle ~128 KB; no CC0 soccer ball surfaced.
   New genres: food/cooking; castle/platformer/racing/animals extended.
   Real-Chromium proof: hero (25 anims), bat (2), burger, catapult render
   textured, verdict clean. 464 tests green. Remaining: human-run
   `vendor-models.mjs --upload` (the 30 new); gallery pass + kid UAT.

## 13. Migration to our own bucket (when DEPLOY_RUNBOOK §8 triggers fire)

Games never notice — they reference `assets.ariantra.com`; only the
CloudFront origin changes. In order: (1) new bucket gets the contract FIRST
(deny-delete + CORS — bucket config does NOT travel with `aws s3 sync`;
per-object Cache-Control does); (2) sync the prefix; (3) verify pre-flip:
re-hash every object against its filename (a corrupted copy cannot bear the
right name) + ledger test against the new bucket; (4) flip the origin — the
entire cutover; edge caches keep serving immutable objects throughout, zero
downtime; (5) ledger smoke through the public path; (6) old bucket stays
intact for a verification period — rollback = flip back. Env-only on our
side; the manifest `url` field never changes.

## 14. Scale ceilings & revisit triggers

- **Catalog size:** *Amendment 3 (2026-07-24) — per-message retrieval is
  RETIRED from the build-turn prompt; the catalog now teaches the WHOLE
  library, grouped by category (`prompt-catalog.ts`).* Two reasons, both
  load-bearing:
  1. **Correctness.** Retrieval picked models from the CHILD's words, but the
     catalog is consumed by the LLM's DESIGN decisions, which happen after
     selection. "Make me a fun game" triggered no genre, so the model was
     taught 6 of 106 models, then built a pizza restaurant out of primitives
     while 19 food models sat unused. `inject.ts` resolves `USES_MODELS`
     against the **full manifest**, so those names always worked — the prompt
     was simply withholding them. The gap widened with the library: 28% of
     models visible at 106, 10% at the 300 target.
  2. **Cost.** A system prompt that varies per message breaks Gemini implicit
     caching on the whole append-only prefix behind it, including ~10–15k
     tokens of repeated game code (`COST_TOKEN_BUDGET.md` waste-ledger #4,
     ~₹20–30/day). A byte-stable catalog is what lets that cache hit.

  Measured cost: **~889 tokens at 106 models**, replacing a 150–290-token
  *varying* block. New ceiling is **1,500 tokens (pinned by test)** — past it,
  fall back to a category-map hybrid (headings + counts static, exact names
  retrieved). `selectModelNames`/`PROMPT_MODEL_CAP` are retained, unwired, as
  that documented fallback. Catalog tokens now grow linearly with the library
  (~3k at 1000 models) — the accepted trade for full design visibility.

  Genre **membership** moved off the hardcoded `GENRES[].models` arrays onto
  the assets themselves (`asset-taxonomy.ts`), so adding a model can no longer
  desync from selection or the prompt. `GENRES` keeps label + trigger only.
  Shared-animation-clip sets are keyed by a `rig` field, deliberately NOT by
  genre — the `people` genre also holds `grandstand`, and a stadium must never
  be described to the model as having a walk cycle. Manifest sanity ceiling
  120 (test) — revisit at the next doubling.
- **First-load transfer:** revisit if games want > 5 models or longer music
  (raise the 2 MB transfer cap deliberately, or add per-genre asset
  bundles — never per-game embedding again).
- **Asset-host availability:** any incident → add an uptime monitor beyond
  the post-deploy smoke; consider a second CloudFront behavior/failover
  origin. (Day-one posture: boring config + standing smoke is enough.)
- **1 GB box:** nothing changes; any future feature that puts asset bytes on
  the box re-derives `MEMORY_BUDGET.md`.
- **Render budget:** runtime governor only on real-device jank (Mixpanel).

## 15. Decisions log (locked)

| # | Decision | Chosen | Why |
|---|---|---|---|
| A | Packaging | **End-state built as v1: shared immutable asset host, URL references** (no embed phase, no per-game copies) | Dedupe + shared cross-game browser cache + tiny HTML; embedding would ship a migration debt on day one. Price accepted: the contract gates the rollout (Phase A) |
| B | Engine delivery | **Served from the asset host** (`three.{hash}.js`), not embedded; upgrades = new hash, old games keep theirs forever | Removes the Phase-0 `readFileSync` failure class structurally; ~550 KB cached once per device across all games |
| C | Library master | S3 `sites/assets/` served by the EXISTING CloudFront wildcard as `assets.ariantra.com` | Zero new infra — reserve a slug + pick a prefix |
| D | Box footprint | **No box-side asset cache, no `sync:assets`** — the box holds only the in-repo `manifest.json`; injector is string-concat with zero I/O | The end-state deleted a moving part; nothing to leak, sync, or OOM on the 1 GB box |
| E | Immutability mechanism | **Content-hash names + deny-delete policy + attack-tests + canary**; no S3 Object Lock | Hash-naming makes overwrite meaningless; Object Lock needs bucket-level control we don't have on borrowed infra |
| F | Audio scope | SFX freely + one ≤400 KB music loop/game, MP3; synthesized Web Audio logged as future lever | SFX = best impact-per-byte; music capped as the only budget risk; MP3 iOS-safe (gapless looping via the Web-Audio helper — §10b R2) |
| G | Tier gating | Keyword-for-all now; always-on-for-paid when entitlement (#11) lands; 3D and audio gate independently; all nested under a build-turn gate | No block on unbuilt entitlement; audio helps 2D games; chit-chat pays zero catalog tokens (#33) |
| H | Starter 5 models | car, dino, tree, coin, rocket | Racing / adventure / collectible / space + universal scenery |
| I | Free triggers | 3D: token "3d"; audio: "sound/music/sound effects"; server regex, no LLM call; err toward unlocking | False unlock costs tokens; under-unlock costs a kid's experience |
| J | Budgets | 100 KB model / 30 KB SFX / 400 KB music / 500 KB audio-per-game / **2 MB first-load transfer** (the binding cap; publish bundle limits 5 MB/30 MB stay as the outer bound) | Worst case 1.35 MB cold; typically a few hundred KB since the engine is already cached |
| K | Client floor | ~2018 budget Android / entry Chromebook; any WebGL device, no dedicated GPU; ≤100K tris + ≤100 draw calls/frame; no fps-governor v1 | Low-poly leaves huge margin; enforced via prompt rules + contract test |
| L | Downloaded-file play | **Works online (CORS `*`), not offline** — a saved .html plays fully whenever the kid has internet; with no connection its 3D/audio won't load | Assets are public CC0, so open CORS costs nothing and shrinks this trade to offline-only; the Arcade is the product, and in-Arcade play is cache-fast after first load |
| M | Asset visibility | **Kid-facing gallery** (`kidgemini/assets`) rendered from the manifest; everyone sees everything, cards teach the trigger phrases (read-aloud on request, §9c); ships with Phase C | Discovery drives usage — an invisible library never gets asked for; zero backend; dogfoods the contract as the human smoke check |
| N | Content ladder | **Inline model-generated content stays ungated on every tier** (§5); gates apply only to the engine (marker) and the library (tier/keyword) | The library is a quality upgrade, never a capability gate; gives fail-soft a floor; keeps the free product whole and the paid pitch honest |

**Assumptions to confirm cheaply (not blockers):** MarksZen owner applies
the prefix deny-delete policy AND the bucket CORS config (the two external
dependencies in Phase A — or CORS moves to a CloudFront Response Headers
Policy on our side, §10.4); the
paid-tier signal reads Razorpay `periodEndsAt` when entitlement lands;
whether kidgemini exposes a clean "build-a-game turn" signal or we add one;
final trigger keywords once real kid phrasings show up in Mixpanel.
