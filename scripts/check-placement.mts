// Does placeModel() actually place things correctly? (2026-08-15)
//
// The unit suite can only assert that the injected helper CONTAINS the right
// code — the same blind spot that let loadModelBatch place every prop rotated
// and sunk for five days while its tests passed. This runs the real helper, in
// a real browser, against the real published GLBs, and checks the three things
// a game gets wrong on its own:
//
//   1. GROUND    — the model's lowest point rests on y = 0, not half-buried.
//   2. HEADING   — asking for "+z" really does point the model's front south,
//                  whatever direction it was authored facing.
//   3. METRES    — `metres: true` gives it its real-world size, so a house
//                  ends up bigger than the car parked outside it.
//
//   npx tsx scripts/check-placement.mts [--png OUT.png]
//
// Exit 0 = all checks pass.

import { readdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ensureAssetRuntime } from "../src/lib/assets/ensure-runtime";
import manifest from "../src/lib/assets/manifest.json";

const argv = process.argv.slice(2);
const pngIdx = argv.indexOf("--png");
const PNG = pngIdx >= 0 ? argv[pngIdx + 1] : null;

const entry = (n: string) => (manifest.assets as { name: string; facing?: string; realSize?: number[] }[]).find((a) => a.name === n);

// car is authored facing -z, house has no facing but a real size — between
// them they exercise every branch.
const page = ensureAssetRuntime(`<!DOCTYPE html><html><head></head><body><canvas id="c"></canvas>
<script type="module">
// seeds: loadModel("car"); loadModel("house"); loadModel("tree");
import { Scene, PerspectiveCamera, WebGLRenderer, DirectionalLight, AmbientLight, Box3, Vector3 } from "three";
const scene = new Scene();
const renderer = new WebGLRenderer({ antialias: true });
renderer.setSize(760, 760);
renderer.setClearColor(0xeef2f6, 1);
document.body.appendChild(renderer.domElement);
scene.add(new AmbientLight(0xffffff, 0.85));
const sun = new DirectionalLight(0xffffff, 1.0); sun.position.set(6, 12, 4); scene.add(sun);

const measure = (o) => {
  const b = new Box3().setFromObject(o);
  const s = new Vector3(); b.getSize(s);
  return { minY: +b.min.y.toFixed(3), x: +s.x.toFixed(2), y: +s.y.toFixed(2), z: +s.z.toFixed(2),
           rotY: +(o.rotation.y).toFixed(4) };
};

(async () => {
  const out = {};
  // A car asked to head SOUTH (+z), at real-world size.
  const car = await placeModel("car", { at: { x: -4, z: 0 }, heading: "+z", metres: true });
  if (car) scene.add(car);
  out.car = car ? measure(car) : null;
  // The same car asked to head NORTH (-z) — its authored direction.
  const car2 = await placeModel("car", { at: { x: 4, z: 0 }, heading: "-z", metres: true });
  if (car2) scene.add(car2);
  out.carNorth = car2 ? measure(car2) : null;
  // A house at real size: must dwarf the car.
  const house = await placeModel("house", { at: { x: 0, z: 10 }, metres: true });
  if (house) scene.add(house);
  out.house = house ? measure(house) : null;
  // A tree placed with no options at all — must still stand on the ground.
  const tree = await placeModel("tree", { at: { x: 10, z: 6 } });
  if (tree) scene.add(tree);
  out.tree = tree ? measure(tree) : null;

  // The curated three bundle exports no OrthographicCamera, so fake one with
  // a very narrow FOV from far away — the same trick scripts/render-assets.mjs
  // uses for its map views.
  const FOV = 6, SPAN = 20;
  const cam = new PerspectiveCamera(FOV, 1, 0.1, 4000);
  const dist = (SPAN / 2) / Math.tan((FOV / 2) * (Math.PI / 180));
  cam.position.set(0, dist, 0);
  cam.up.set(0, 0, -1);            // +Z renders DOWNWARD, like the audit sheets
  cam.lookAt(0, 0, 0);
  renderer.render(scene, cam);
  out.__debug = { camY: +cam.position.y.toFixed(1), carPos: car ? [car.position.x, +car.position.y.toFixed(2), car.position.z] : null };
  window.__result = out;
})().catch((e) => { window.__result = { error: String(e) }; });
</script></body></html>`);

const dir = mkdtempSync(join(tmpdir(), "placement-"));
writeFileSync(join(dir, "p.html"), page);
const server = createServer((req, res) => {
  try {
    const p = resolve(dir, decodeURIComponent((req.url ?? "/").slice(1)));
    res.writeHead(200, { "content-type": extname(p) === ".html" ? "text/html" : "application/octet-stream" });
    res.end(readFileSync(p));
  } catch {
    res.writeHead(404).end("no");
  }
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;

const pw = await (async () => {
  try { return await import("playwright-core"); }
  catch {
    const d = process.env.PLAYWRIGHT_CORE_DIR;
    if (!d) throw new Error("playwright-core not installed — set PLAYWRIGHT_CORE_DIR");
    return await import(pathToFileURL(`${d}/index.mjs`).href);
  }
})();
const cache = `${process.env.HOME}/Library/Caches/ms-playwright`;
const build = readdirSync(cache).find((d) => d.startsWith("chromium_headless_shell-"))!;
const browser = await pw.chromium.launch({
  executablePath: `${cache}/${build}/chrome-headless-shell-mac-arm64/chrome-headless-shell`,
});
const tab = await browser.newPage({ viewport: { width: 780, height: 780 } });
const errors: string[] = [];
tab.on("pageerror", (e) => errors.push(e.message));
await tab.goto(`http://127.0.0.1:${port}/p.html`);
await tab.waitForFunction("window.__result !== undefined", { timeout: 60_000 }).catch(() => {});
const r = await tab.evaluate("window.__result") as Record<string, { minY: number; x: number; y: number; z: number; rotY: number } | null> & { error?: string };
if (PNG) await tab.screenshot({ path: PNG });
await browser.close();
server.close();

if (!r || r.error) {
  console.error("placement run failed:", r?.error ?? "no result", errors.slice(0, 3).join(" | "));
  process.exit(1);
}

const checks: Array<[string, boolean, string]> = [];
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

for (const name of ["car", "carNorth", "house", "tree"]) {
  const m = r[name];
  checks.push([`${name} loaded`, !!m, m ? "" : "placeModel returned null"]);
  if (m) checks.push([`${name} stands on the ground`, near(m.minY, 0, 0.02), `base y = ${m.minY}`]);
}

// car is authored facing -z. Asking for +z must be a half turn; asking for -z
// must be no turn at all.
const HALF = Math.PI;
if (r.car) checks.push(["car asked south turns 180 degrees", near(Math.abs(r.car.rotY), HALF, 0.01), `rotation.y = ${r.car.rotY}`]);
if (r.carNorth) checks.push(["car asked north does not turn", near(r.carNorth.rotY, 0, 0.01), `rotation.y = ${r.carNorth.rotY}`]);

// metres: the car should be about its real length, and the house must dwarf it.
const carReal = entry("car")?.realSize;
if (r.car && carReal) {
  checks.push([`car is about ${carReal[2]}m long`, near(r.car.z, carReal[2], carReal[2] * 0.25), `measured ${r.car.z}m`]);
}
if (r.car && r.house) {
  checks.push(["house is taller than the car", r.house.y > r.car.y * 2, `house ${r.house.y}m vs car ${r.car.y}m`]);
  checks.push(["house is wider than the car", r.house.x > r.car.x * 1.5, `house ${r.house.x}m vs car ${r.car.x}m`]);
}

let failed = 0;
for (const [name, ok, detail] of checks) {
  console.log(`  ${ok ? "✓" : "✖"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
}
if (errors.length) console.log(`  page errors: ${errors.slice(0, 3).join(" | ")}`);
if (PNG) console.log(`\n  render: ${PNG}`);

console.log(`\n${checks.length - failed}/${checks.length} placement checks passed.`);
process.exit(failed > 0 ? 1 : 0);
