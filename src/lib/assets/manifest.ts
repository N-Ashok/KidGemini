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
  /** Library assets (model/sfx/music) are CC0-only — zero licensing risk
   *  (PRD §2.6). The engine is the one exception: three.js is MIT, whose
   *  notice ships inside the bundle (esbuild legal comments). */
  license: "CC0" | "MIT";
  /** Where the asset came from — the license proof trail. */
  sourceUrl: string;
  /** Full sha256 (hex) of the exact published bytes. */
  sha256: string;
}

export interface AssetManifest {
  assets: AssetEntry[];
}

/** First-load download budgets per asset type, in bytes (PRD §8, Decision J). */
export const BUDGET_BYTES: Record<AssetType, number> = {
  model: 100_000,
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
  const allowedLicense = e.type === "engine" ? ["CC0", "MIT"] : ["CC0"];
  if (!allowedLicense.includes(e.license)) {
    throw new Error(`license must be ${allowedLicense.join(" or ")} for ${e.type} "${e.name}" (got "${e.license}")`);
  }
  if (!SHA256_RE.test(e.sha256)) throw new Error(`malformed sha256 for "${e.name}"`);
  if (!Number.isInteger(e.bytes) || e.bytes <= 0) throw new Error(`bytes must be a positive integer for "${e.name}"`);
  if (e.bytes > BUDGET_BYTES[e.type]) {
    throw new Error(
      `"${e.name}" is over the ${e.type} byte budget: ${e.bytes} > ${BUDGET_BYTES[e.type]}`,
    );
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
