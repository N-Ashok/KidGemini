// The in-repo manifest of the shared immutable asset host
// (assets.ariantra.com — PRD-3D-GAMES-AND-ASSETS §4.4). This module is the
// single source of truth for the contract's mechanical rules: hash-derived
// filenames, per-type byte budgets, CC0-only licensing, asset-host-only URLs.
// The vendor pipeline (scripts/vendor-*.mjs) writes entries through these
// validators; the injector and prompt catalog (Phase B+) read them; the test
// suite attacks them. No I/O here — pure rules.

export const ASSET_HOST_ORIGIN = "https://assets.ariantra.com";

export type AssetType = "model" | "sfx" | "music" | "engine";

export interface AssetEntry {
  /** Catalog name the model asks for (`car`, `coin_pickup`, `three`). */
  name: string;
  type: AssetType;
  /** Immutable public URL: {ASSET_HOST_ORIGIN}/{name}.{sha256[0:6]}.{ext} */
  url: string;
  bytes: number;
  /** Library assets prefer CC0 (zero obligations — PRD §2.6). Owner decision
   *  2026-08-06 (motorcycle batch): MODELS may also be CC-BY 3.0, because the
   *  platform now discharges the attribution duty mechanically — inject.ts
   *  bakes an art-credits chip into every game that uses a CC-BY model, and
   *  the gallery + prompt catalog show the credit while making. The engine is
   *  the other exception: three.js is MIT, whose notice ships inside the
   *  bundle (esbuild legal comments). sfx/music stay CC0-only until the chip
   *  covers audio too. */
  license: "CC0" | "MIT" | "CC-BY-3.0";
  /** Creator display name — REQUIRED for CC-BY entries (it IS the credit
   *  line); omitted for CC0/MIT. */
  author?: string;
  /** Where the asset came from — the license proof trail, and for CC-BY the
   *  link target of the credit line. */
  sourceUrl: string;
  /** Full sha256 (hex) of the exact published bytes. */
  sha256: string;
  /** World-space bounding-box size of the PUBLISHED glb, in METRES, as
   *  [x, y, z] — measured by scripts/vendor-models.mjs after every transform
   *  (rotateYDeg, normalizeLongest/normalizeFootprint, simplify, meshopt), so
   *  it is the size the game actually renders at scale 1. This is what reaches
   *  a generated game as `window.AR_SIZES` / `modelSize(name)`: before
   *  2026-08-08 NO dimension data existed anywhere the model could see it, and
   *  it laid 1 m road tiles 10 m apart (BUG-FIX-LOG 2026-08-08).
   *
   *  OPTIONAL, deliberately: entries minted before 2026-08-08 have none, and
   *  SKINNED models are omitted — their POSITION accessor is in bind space and
   *  a skinned mesh ignores its node transform per spec, so the measurement
   *  would be wrong rather than missing. `modelSize()` returns null for those
   *  and the game falls back to eyeballing, exactly as it does today.
   *
   *  A tuple, not {x, y, z}: manifest.json is bundled into the CLIENT (see the
   *  static import in ensure-runtime.ts), and this is the exact value shape
   *  shipped in AR_SIZES — so the injector is a pass-through and the table's
   *  values contain no `}` for the block regexes to trip over. */
  size?: [number, number, number];
  /** Which axis a PATH piece's road/track runs along at rest — `'x'`, `'z'`,
   *  or `'none'` for a hub/corner (intersection, roundabout, curve) that has
   *  no single run axis. Reaches a generated game as `window.AR_AXES` /
   *  `modelAxis(name)`.
   *
   *  WHY THIS EXISTS (BUG-FIX-LOG 2026-08-08, "poorly formed race track").
   *  The two road kits disagree: the CITY kit's `road_straight` runs along X,
   *  the RACING kit's `race_track_straight` runs along Z. Nothing exposed
   *  that, and `size` cannot: `road_straight` is 1 × 1 m — perfectly square,
   *  so its footprint carries zero orientation information. The prompt
   *  meanwhile asserted "Every model faces +Z at rest", which is true of the
   *  racing kit and FALSE of the city kit — so the model dutifully rotated
   *  every city tile 90° wrong, every time, and no amount of re-prompting
   *  could fix it.
   *
   *  DECLARED, not auto-detected — same discipline as `assertLongAxis`. Two
   *  independent geometric heuristics (extrusion uniformity, raised
   *  kerb/railing runs) agree on the straights but DISAGREE on `road_bridge`,
   *  so shipping a detector's guess would have been the confidently-wrong
   *  number TECH_DEBT #93 exists to refuse. Absent = unknown; `modelAxis()`
   *  answers null and the game eyeballs it, exactly as before. */
  pathAxis?: "x" | "z" | "none";
  /** Which of the tile's four world edges its carriageway actually reaches at
   *  rest, e.g. `["-x", "+z"]` for a corner that turns from west to south.
   *  Reaches a generated game as `window.AR_EDGES` / `modelJoins(name)`.
   *
   *  WHY THIS EXISTS (BUG-FIX-LOG 2026-08-09, the second "poorly formed race
   *  track"). `pathAxis` fixed the STRAIGHTS but answers `'none'` for every
   *  corner and hub — a real answer to "which axis does it run along", and a
   *  non-answer to the only question that lets a model rotate a corner. With
   *  nothing to reason from it guessed rotations 0, -pi/2, pi, pi/2 and the
   *  track never closed. No amount of re-prompting could fix it, because the
   *  information did not exist anywhere in the system.
   *
   *  MEASURED, not declared — the one place this contract departs from
   *  `pathAxis`, and deliberately. It is measured from a TOP-DOWN RENDER of
   *  the published bytes (scripts/render-assets.mjs), never from the geometry:
   *  these tiles are flat single-material slabs with the road painted into the
   *  colormap, so the mesh is a rectangle whichever way the road runs, and two
   *  independent geometric probes both returned "(none)". The pixels are the
   *  only instrument that can see a painted road. */
  joins?: ("-x" | "+x" | "-z" | "+z")[];
  /** Where along each joined edge the carriageway CENTRE sits, in metres from
   *  the piece's own minimum on that edge's axis.
   *
   *  Edge names alone cannot separate a valid multi-cell piece from a broken
   *  one, and the difference is the whole 2026-08-09 bug: `road_curve` joins at
   *  0.50 m and 1.50 m on a 2 m tile — both CELL CENTRES, so straights meet it
   *  squarely — while `race_track_curve` joins at 0.50 m and 1.00 m, and 1.00 m
   *  is a cell BOUNDARY. Nothing on a 1 m grid can follow it. Both pieces have
   *  identical `joins` and identical `lane`; only this field tells them apart. */
  joinOffsets?: Record<string, number>;
  /** How a path piece meets the grid. `tile` occupies whole grid cells and is
   *  held to the module and cell-centre contract. `prop` straddles the road
   *  without tiling it (a start gantry, a finish line) — its footprint may
   *  overhang freely, so only its carriageway has to match the kit.
   *
   *  Introduced 2026-08-09 after trying to do without it: `finish_line` is
   *  1.26 m wide against a 1 m module, which reads as a hard module failure
   *  under a tile rule and is in fact correct — the extra width is verge
   *  hanging over the grass, and the piece mates the racing straight perfectly
   *  on its 0.70 m carriageway. Deriving this from the name or the numbers is
   *  precisely the guessing this whole subsystem exists to stop. */
  pathRole?: "tile" | "prop";
  /** Carriageway width in METRES at scale 1 — the drivable width where the
   *  road meets an edge, NOT the tile's bounding box. Measured alongside
   *  `joins`.
   *
   *  This is the number that says whether two pieces mate, and the bounding
   *  box actively lies about it: `finish_line` is 1.26 m wide and
   *  `race_track_straight` is 1.00 m, so by footprint they look mismatched —
   *  but both carry a 0.70 m carriageway and mate perfectly. The 2026-08-08
   *  game reasoned from the footprint, scaled finish_line x10 while scaling
   *  straights x20, and produced a 7 m gantry over a 20 m road. */
  lane?: number;
  /** Which vendored pack a piece came from (`"city"`, `"racing"`). Pieces only
   *  have to mate WITHIN a kit — the two road kits genuinely disagree (0.81 m
   *  vs 0.70 m carriageway, X vs Z run axis), so a cross-kit comparison would
   *  report a fault that is really a design difference. Cannot be derived from
   *  the name: `finish_line` is racing-kit but shares no prefix with it. */
  kit?: string;
  /** Which way this model's FRONT points at rest — `"+z"`, `"-z"`, `"+x"` or
   *  `"-x"`. Reaches a generated game as `window.AR_FACING` /
   *  `modelFacing(name)`, and is what `placeModel()` uses to aim a model.
   *
   *  WHY THIS EXISTS (2026-08-15, owner: "the llm is not getting the axis,
   *  size, direction correct"). The prompt asserted, unconditionally, that
   *  "VEHICLES/CHARACTERS face +Z". A render audit of the catalog shows that
   *  is simply untrue: `car` faces -Z (180° out) and `airplane` faces +X (90°
   *  out), while `crocodile` and `dog` do face +Z. `size` cannot express this
   *  — a bounding box is identical for a car facing +Z and the same car facing
   *  -Z — so before this field there was NO datum anywhere, in the prompt or
   *  the runtime, that could tell a game which way a model points. Every
   *  generated game re-guessed it, which is why wrong-facing models recur
   *  across unrelated games (TECH_DEBT #91).
   *
   *  MEASURED BY RENDER, not by geometry heuristic — the same discipline as
   *  `pathAxis`. A "which end is the front" question has no reliable
   *  geometric answer (the long axis is direction-blind, and mass/asymmetry
   *  disagree on real models), so each value is read off a top-down render
   *  from scripts/render-assets.mjs. Absent = unknown: `modelFacing()` answers
   *  null and `placeModel()` leaves rotation alone, exactly as today.
 *
 *  RESTORED 2026-08-23. This field, its data and its helpers were lost as
 *  unlisted collateral of the 2026-08-17 revert to the 2026-08-12 tree
 *  (ab386a5, whose own "what this gives up" list never mentions them).
 *  Every value below is the ORIGINAL audited one: no surviving model's
 *  sha256 changed in between, so each is still true of the exact GLB we
 *  serve. See BUG-FIX-LOG 2026-08-23. */
  facing?: "+x" | "-x" | "+z" | "-z";
  /** The model's size in TRUE real-world metres, `[x, y, z]` — what this
   *  object measures in life, not in the catalog's units.
   *
   *  SEPARATE from `size`, deliberately, and NOT a correction to it. `size` is
   *  the honestly-measured extent of the published GLB, and live games already
   *  do `want ÷ modelSize(name)` with those numbers; redefining it would
   *  silently change the arithmetic of every stored game. So the real figure
   *  ships alongside, reached by the new `modelMetres(name)`.
   *
   *  WHY (2026-08-15): the catalog mixes two scale systems. 238 of 296 sized
   *  models are raw kit units (max dimension <= 3) while 58 are real metres,
   *  because only a handful of vendor entries carry `normalizeLongest`. The
   *  result is a table where `mountain` is 1.9 units tall and `car` is 2.56
   *  long — a mountain smaller than a car, a house narrower than one — while
   *  the prompt calls all of it "REAL metres". A model asked to build a
   *  village has no way to place a house next to a car at a believable size,
   *  so it invents a scale factor per game and they disagree.
   *
   *  CURATED per model (a real-world dimension is knowledge, not a
   *  measurement of the mesh), and reviewable: absent = unknown, and
   *  `modelMetres()` answers null.
   *
   *  RESTORED 2026-08-23 with `facing` — same revert, same provenance. */
  realSize?: [number, number, number];
}

export interface AssetManifest {
  assets: AssetEntry[];
}

/** First-load download budgets per asset type, in bytes (PRD §8, Decision J). */
export const BUDGET_BYTES: Record<AssetType, number> = {
  // Raised 100 K → 150 K 2026-07-29 (owner decision, military batch) — keep in
  // sync with MODEL_BUDGET_BYTES in scripts/vendor-models.mjs. The three
  // realistic tanks land at 118–144 KB and are IRREDUCIBLE: they are
  // flat-shaded, so simplify() cannot weld an edge and returns byte-identical
  // output at every ratio down to 0.25 (probed 2026-07-29). Worst case first
  // load stays inside the §8 2 MB cap: 650 K engine + 5 × 150 K = 1.4 MB.
  // This deliberately re-opens size rejections made on the old line. All but
  // one are still over (Penguin/Bunny ~154 K, Panda ~177 K, Shiba ~241 K,
  // Deer/Fox ~260 K, Husky ~266 K, horses ~305 K); Turtle ~128 K is newly
  // eligible and is logged in that PRD as a follow-up for the animals genre.
  model: 150_000,
  sfx: 30_000,
  music: 400_000,
  // three.{hash}.js incl. GLTFLoader + MeshoptDecoder (models are gltfpack
  // -cc) + AnimationMixer/Box3 (Phase C) — ~595 KB actual, with headroom.
  // Raised 600 → 650 K 2026-07-12; worst-case first load stays ≈ 1.4 MB (§8).
  engine: 650_000,
};

const EXT_BY_TYPE: Record<AssetType, string> = {
  model: "glb",
  sfx: "mp3",
  music: "mp3",
  engine: "js",
};

export const MIME_BY_TYPE: Record<AssetType, string> = {
  model: "model/gltf-binary",
  sfx: "audio/mpeg",
  music: "audio/mpeg",
  engine: "text/javascript",
};

const NAME_RE = /^[a-z0-9_]{2,32}$/;
/** A trailing `_<digits>` is unique but says nothing — `tree_2` teaches the LLM
 *  and the gallery exactly as much as `tree`. Banned so a growing library stays
 *  self-describing; the convention is `{specific}_{category}` (`oak_tree`).
 *  Names are baked into the immutable URL, so this can only be enforced at the
 *  moment of minting — there is no rename later. */
const NUMBERED_DUPLICATE_RE = /_\d+$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
/** Hash fragment length in the filename — enough that a collision within one
 *  name is unrealistic, short enough to stay a readable URL (car.a3f8c2.glb). */
const HASH_FRAGMENT_LEN = 6;

/** `{name}.{sha256 first 6}.{ext}` — the name IS the integrity check and the
 *  immutability mechanism: changed bytes = new name, so overwrite is
 *  meaningless, not merely forbidden (PRD §4.3). */
export function hashedFileName(name: string, ext: string, sha256: string): string {
  if (!NAME_RE.test(name)) throw new Error(`asset name must match ${NAME_RE}: "${name}"`);
  if (!SHA256_RE.test(sha256)) throw new Error(`malformed sha256 for "${name}"`);
  return `${name}.${sha256.slice(0, HASH_FRAGMENT_LEN)}.${ext}`;
}

export function assetUrl(fileName: string): string {
  return `${ASSET_HOST_ORIGIN}/${fileName}`;
}

/** Throws with a precise reason on the first rule an entry breaks. */
export function validateEntry(e: AssetEntry): void {
  if (!NAME_RE.test(e.name)) throw new Error(`asset name must match ${NAME_RE}: "${e.name}"`);
  if (NUMBERED_DUPLICATE_RE.test(e.name)) {
    throw new Error(
      `asset name "${e.name}" ends in a number — use a descriptive {specific}_{category} name ` +
        `(e.g. "oak_tree", not "tree_2"): the name is permanent and is all the catalog can match on`,
    );
  }
  if (!(e.type in BUDGET_BYTES)) throw new Error(`unknown asset type "${e.type}" for "${e.name}"`);
  const allowedLicense =
    e.type === "engine" ? ["CC0", "MIT"] : e.type === "model" ? ["CC0", "CC-BY-3.0"] : ["CC0"];
  if (!allowedLicense.includes(e.license)) {
    throw new Error(`license must be ${allowedLicense.join(" or ")} for ${e.type} "${e.name}" (got "${e.license}")`);
  }
  if (e.license === "CC-BY-3.0" && !(e.author ?? "").trim()) {
    throw new Error(
      `CC-BY model "${e.name}" needs an author — the credits chip (inject.ts) has no name to show without it`,
    );
  }
  if (!SHA256_RE.test(e.sha256)) throw new Error(`malformed sha256 for "${e.name}"`);
  if (!Number.isInteger(e.bytes) || e.bytes <= 0) throw new Error(`bytes must be a positive integer for "${e.name}"`);
  if (e.bytes > BUDGET_BYTES[e.type]) {
    throw new Error(
      `"${e.name}" is over the ${e.type} byte budget: ${e.bytes} > ${BUDGET_BYTES[e.type]}`,
    );
  }
  if (e.size !== undefined) {
    if (e.type !== "model") {
      throw new Error(`only models carry a size — "${e.name}" is a ${e.type}`);
    }
    if (!Array.isArray(e.size) || e.size.length !== 3) {
      throw new Error(`size for "${e.name}" must be [x, y, z] metres`);
    }
    for (const v of e.size) {
      // A zero/negative axis silently stacks every tile on the origin once a
      // game steps by it. The upper bound is a typo guard, not a design limit:
      // the largest real entry is suspension_bridge at 50 m, so a 1e7 means an
      // un-normalized author scale slipped past normalizeLongest.
      if (!Number.isFinite(v) || v <= 0 || v > 1_000) {
        throw new Error(
          `size for "${e.name}" must be positive finite metres under 1000 (got ${v})`,
        );
      }
    }
  }
  if (e.pathAxis !== undefined) {
    if (e.type !== "model") {
      throw new Error(`only models carry a pathAxis — "${e.name}" is a ${e.type}`);
    }
    if (e.pathAxis !== "x" && e.pathAxis !== "z" && e.pathAxis !== "none") {
      throw new Error(`pathAxis for "${e.name}" must be "x", "z" or "none" (got ${JSON.stringify(e.pathAxis)})`);
    }
  }
  if (!/^https:\/\//.test(e.sourceUrl)) throw new Error(`sourceUrl must be https for "${e.name}" — it is the license proof`);

  const expectedFile = hashedFileName(e.name, EXT_BY_TYPE[e.type], e.sha256);
  const expectedUrl = assetUrl(expectedFile);
  if (e.url !== expectedUrl) {
    // Diagnose the specific mismatch so a bad manifest edit reads its own fix.
    if (!e.url.startsWith(`${ASSET_HOST_ORIGIN}/`)) {
      throw new Error(`url for "${e.name}" is off the asset host (the contract forbids other origins): ${e.url}`);
    }
    const file = e.url.slice(ASSET_HOST_ORIGIN.length + 1);
    const [base, frag, ext] = file.split(".");
    if (base !== e.name) throw new Error(`url filename "${file}" does not carry the entry name "${e.name}"`);
    if (ext !== EXT_BY_TYPE[e.type]) throw new Error(`wrong extension for type ${e.type} in "${file}" (want .${EXT_BY_TYPE[e.type]})`);
    if (frag !== e.sha256.slice(0, HASH_FRAGMENT_LEN)) {
      throw new Error(`filename hash fragment "${frag}" does not match sha256 of "${e.name}" — changed bytes must get a NEW name`);
    }
    throw new Error(`url for "${e.name}" must be exactly ${expectedUrl}`);
  }
}

export function validateManifest(m: AssetManifest): void {
  const seen = new Set<string>();
  for (const e of m.assets) {
    if (seen.has(e.name)) throw new Error(`duplicate asset name "${e.name}" in manifest`);
    seen.add(e.name);
    validateEntry(e);
  }
}

/** Cheap file-type verification for the pipeline: is this buffer plausibly
 *  the format its type claims? (PRD §11 — "valid magic bytes".) */
export function sniffMagicBytes(buf: Buffer, type: AssetType): boolean {
  if (type === "model") return buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "glTF";
  if (type === "sfx" || type === "music") {
    if (buf.length < 4) return false;
    if (buf.subarray(0, 3).toString("ascii") === "ID3") return true;
    return buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0; // bare MPEG frame sync
  }
  // engine: non-trivial ES module text (the real budget/behaviour checks live
  // in the vendor script and bundle test).
  return buf.length > 0 && buf.toString("utf8", 0, 4096).includes("export");
}
