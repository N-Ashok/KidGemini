// Batched-vs-single placement parity for every model in the manifest.
//
// WHY THIS EXISTS (2026-08-15): a child building a car game told her dad the
// trees were "lying down" and the car drove straight through the houses. Both
// came from ONE bug: loadModelBatch() built its InstancedMesh from
// `part.geometry` while throwing away each part's transform INSIDE the model
// (`part.matrixWorld`). loadModel() keeps the node hierarchy, so a single tree
// stands up and a batched one falls over, sinks into the ground, or changes
// size. Measured on her actual game's models: snow_pine 1.25x3.34x1.39 became
// 0.75x0.83x2.00 (on its side); mountain likewise; tree/house/skyscraper lost
// their base offset and sat half underground.
//
// It also broke collision without touching any collision code: games record a
// solid at the LOGICAL instance position while the mesh is drawn somewhere
// else, so the car stops at invisible walls and passes through visible houses.
//
// Nothing caught it because the helper is an injected <script> string — the
// unit suite can assert it is PRESENT, never that it PLACES THINGS CORRECTLY.
// This is that missing instrument: same model, same transform, both paths,
// real browser, real GLBs. Compare bounding boxes.
//
//   npx tsx scripts/check-batch-parity.mts [--model snow_pine] [--headed]
//
// Exit 0 = every model places identically through both paths.

import { readdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ensureAssetRuntime } from "../src/lib/assets/ensure-runtime";
import manifest from "../src/lib/assets/manifest.json";

const argv = process.argv.slice(2);
const HEADED = argv.includes("--headed");
const only = argv.indexOf("--model") >= 0 ? argv[argv.indexOf("--model") + 1] : null;

/** Bounding boxes are floats through two different code paths — compare with
 *  a tolerance that is tight enough to catch a sunk base (0.4+) or a rotation
 *  (whole axes swapped) but loose enough not to flag float noise. */
const TOL = 0.02;

const models = (manifest.assets as { name: string; type: string }[])
  .filter((a) => a.type === "model")
  .map((a) => a.name)
  .filter((n) => (only ? n === only : true));

if (models.length === 0) {
  console.error(only ? `no such model: ${only}` : "no models in manifest");
  process.exit(2);
}

// ensureAssetRuntime recovers the AR_ASSETS table from LITERAL loadModel("x")
// call sites, so every name under test must appear literally in the source.
const seeds = models.map((m) => `loadModel(${JSON.stringify(m)});`).join(" ");

const page = ensureAssetRuntime(`<!DOCTYPE html><html><head></head><body><canvas id="c"></canvas>
<script type="module">
// asset-table seeds (never executed): ${seeds}
import { Scene, PerspectiveCamera, WebGLRenderer, DirectionalLight, Box3, Vector3 } from "three";
const scene = new Scene();
const cam = new PerspectiveCamera(60, 1, 0.1, 1000);
const renderer = new WebGLRenderer({ canvas: document.getElementById("c") });
scene.add(new DirectionalLight(0xffffff, 1));
const NAMES = ${JSON.stringify(models)};
const size = (b) => { const v = new Vector3(); b.getSize(v); return [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)]; };
const center = (b) => { const v = new Vector3(); b.getCenter(v); return [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)]; };
window.__rows = [];
(async () => {
  for (const name of NAMES) {
    try {
      const single = await loadModel(name);
      if (!single) { window.__rows.push({ name, skipped: "loadModel returned null" }); continue; }
      single.position.set(0, 0, 0);
      scene.add(single);
      scene.updateMatrixWorld(true);
      const bSingle = new Box3().setFromObject(single);

      const batch = await loadModelBatch(name, 1);
      if (!batch) { scene.remove(single); window.__rows.push({ name, skipped: "not batchable (animated)" }); continue; }
      scene.add(batch.mesh);
      // The IDENTITY transform: whatever loadModel() renders at the origin is
      // exactly what one batched instance at the origin must render.
      batch.setInstance(0, { position: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, rotation: { x: 0, y: 0, z: 0 } });
      scene.updateMatrixWorld(true);
      const bBatch = new Box3().setFromObject(batch.mesh);

      window.__rows.push({ name, singleSize: size(bSingle), batchSize: size(bBatch), singleCenter: center(bSingle), batchCenter: center(bBatch) });
      scene.remove(single);
      scene.remove(batch.mesh);
    } catch (e) {
      window.__rows.push({ name, error: String(e).slice(0, 120) });
    }
  }
  renderer.render(scene, cam);
  window.__done = true;
})();
</script></body></html>`);

const dir = mkdtempSync(join(tmpdir(), "batch-parity-"));
const file = join(dir, "parity.html");
writeFileSync(file, page);

const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript" };
const server = createServer((req, res) => {
  try {
    const p = resolve(dir, decodeURIComponent((req.url ?? "/").slice(1)));
    res.writeHead(200, { "content-type": MIME[extname(p)] ?? "application/octet-stream" });
    res.end(readFileSync(p));
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const pw = await (async () => {
  try {
    return await import("playwright-core");
  } catch {
    const d = process.env.PLAYWRIGHT_CORE_DIR;
    if (!d) throw new Error("playwright-core not installed — set PLAYWRIGHT_CORE_DIR");
    return await import(pathToFileURL(`${d}/index.mjs`).href);
  }
})();
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`;
const build = readdirSync(cache).find((d) => d.startsWith(HEADED ? "chromium-" : "chromium_headless_shell-"))!;
const exe = HEADED
  ? `${cache}/${build}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`
  : `${cache}/${build}/chrome-headless-shell-mac-arm64/chrome-headless-shell`;

const browser = await pw.chromium.launch({ executablePath: exe, headless: !HEADED });
const tab = await browser.newPage();
await tab.goto(`http://127.0.0.1:${port}/parity.html`);
await tab.waitForFunction("window.__done === true", { timeout: 120_000 }).catch(() => {});
type Row = {
  name: string;
  skipped?: string;
  error?: string;
  singleSize?: number[];
  batchSize?: number[];
  singleCenter?: number[];
  batchCenter?: number[];
};
const rows: Row[] = await tab.evaluate("window.__rows");
await browser.close();
server.close();

const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]!) <= TOL);

let bad = 0;
let skipped = 0;
console.log(`${"model".padEnd(20)}${"single WxHxD".padEnd(26)}${"batched WxHxD".padEnd(26)}verdict`);
for (const r of rows ?? []) {
  if (r.skipped) { skipped++; console.log(`${r.name.padEnd(20)}${("— " + r.skipped).padEnd(52)}skip`); continue; }
  if (r.error) { bad++; console.log(`${r.name.padEnd(20)}${("ERROR " + r.error).padEnd(52)}FAIL`); continue; }
  const sizeOk = near(r.singleSize!, r.batchSize!);
  const centerOk = near(r.singleCenter!, r.batchCenter!);
  // A rotation shows up as the tall axis moving; a lost base offset shows up
  // as the centre dropping to 0. Name them, because "sizes differ" alone
  // sends the next person hunting in the wrong place.
  const tallSingle = r.singleSize![1]! >= Math.max(r.singleSize![0]!, r.singleSize![2]!);
  const tallBatch = r.batchSize![1]! >= Math.max(r.batchSize![0]!, r.batchSize![2]!);
  const verdict = sizeOk && centerOk
    ? "ok"
    : tallSingle && !tallBatch
      ? "FAIL rotated (lying down)"
      : !centerOk && sizeOk
        ? "FAIL sunk (base offset lost)"
        : "FAIL wrong size/placement";
  if (!(sizeOk && centerOk)) bad++;
  console.log(`${r.name.padEnd(20)}${JSON.stringify(r.singleSize).padEnd(26)}${JSON.stringify(r.batchSize).padEnd(26)}${verdict}`);
}

const checked = (rows ?? []).length - skipped;
console.log(`\n${checked - bad}/${checked} models place identically through both paths (${skipped} skipped).`);
if (bad > 0) {
  console.log(`✖ ${bad} model(s) render differently when batched — scenery placed with loadModelBatch is wrong.`);
  process.exit(1);
}
console.log("✓ batched and single placement agree.");
