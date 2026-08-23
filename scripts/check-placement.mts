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
// seeds: loadModel("car"); loadModel("house"); loadModel("tree"); loadModel("airplane"); loadModel("dog"); loadModel("horse"); loadModel("explorer"); loadModel("helicopter");
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
  // A +X-FACING model asked to head south. This is the case the first version
  // of this script did not cover: car faces -z, so heading +z/-z are 0 and
  // 180 degrees — symmetric, and blind to an inverted quarter turn. airplane
  // faces +x, so it can only pass if the rotation direction is right.
  const plane = await placeModel("airplane", { at: { x: 0, z: -14 }, heading: "+z" });
  if (plane) scene.add(plane);
  out.plane = plane ? measure(plane) : null;
  // And the steering helper, which is what a moving vehicle actually uses.
  out.headings = {
    carAt0: +modelHeading("car", 0).toFixed(4),
    planeAt0: +modelHeading("airplane", 0).toFixed(4),
    dogAt0: +modelHeading("dog", 0).toFixed(4),
  };

  // A tree placed with no options at all — must still stand on the ground.
  const tree = await placeModel("tree", { at: { x: 10, z: 6 } });
  if (tree) scene.add(tree);
  out.tree = tree ? measure(tree) : null;

  // THE REPORTED CASE (2026-08-23, owner: "giving it direction and teaching how
  // to go is at least 5 prompts"). A rideable horse at real size, headed east,
  // with a rider parented to it. If this is right in one call, it is not five
  // prompts. Both are +z, so the rider needs NO rotation of its own — that is
  // the whole point of a shared convention, and the check that proves it.
  const horse = await placeModel("horse", { at: { x: -10, z: -6 }, heading: "+x", metres: true });
  if (horse) scene.add(horse);
  out.horse = horse ? measure(horse) : null;
  // heading: 0 — "no turn of your own". The default (back to the viewer) is for
  // a model standing on its own; a rider must inherit the MOUNT's direction,
  // or he faces the camera while the horse runs the other way.
  const rider = await placeModel("explorer", { metres: true, heading: 0 });
  if (horse && rider) {
    horse.add(rider);
    out.riderRotY = +rider.rotation.y.toFixed(4);
  }
  out.headingsRide = {
    horseAt0: +modelHeading("horse", 0).toFixed(4),
  };

  // THE DEFAULT ORIENTATION (2026-08-23). Owner's rule: an object placed with
  // no instructions shows the user its BACK. horse is authored +z (nose at the
  // camera) and car is -z (nose away) — opposite models, and before this they
  // gave opposite results from identical code. Both must now face -z, away
  // from a camera sitting on +z. This is the check that says the rule holds
  // for a model regardless of how it was exported.
  const bare = {};
  for (const n of ["horse", "car", "dog"]) {
    const m = await placeModel(n, { at: { x: 0, z: 0 } });
    if (m) {
      // Where the model's own front ends up, in world space, after placement.
      const f = window.modelFacing(n);
      const base = { "+z": 0, "+x": Math.PI / 2, "-z": Math.PI, "-x": -Math.PI / 2 }[f] || 0;
      const world = base + m.rotation.y;
      bare[n] = { facing: f, rotY: +m.rotation.y.toFixed(4), frontZ: +Math.cos(world).toFixed(3), minY: +new Box3().setFromObject(m).min.y.toFixed(3) };
    }
  }
  out.bare = bare;

  // PARTS (2026-08-23, owner: "the car tyres"). The prompt asserted for a year
  // that rigid models have no named parts. A census disproved it; this proves
  // the claim end-to-end in a browser: modelParts must list the car's wheels,
  // getObjectByName must FIND one on the real loaded object, and rotating it
  // must actually move it. A datum that no game can act on is worth nothing.
  const carForParts = await placeModel("car", { at: { x: -20, z: 0 } });
  if (carForParts) {
    const named = window.modelParts("car");
    const w = carForParts.getObjectByName("wheel-front-left");
    let spun = null;
    if (w) {
      const before = w.rotation.x;
      w.rotation.x -= 1.25;
      spun = Math.abs(w.rotation.x - before) > 1;
    }
    out.parts = { list: named, found: !!w, spun };
  }
  // …and the helicopter, which genuinely has none: the fallback must stay.
  const heli = await placeModel("helicopter", { at: { x: -26, z: 0 } });
  out.heliParts = heli ? window.modelParts("helicopter") : "no-model";

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

for (const name of ["car", "carNorth", "house", "tree", "plane"]) {
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
// airplane is 35.8m along X natively; asked to head +z it must now lie along Z.
const planeM = r.plane as { x: number; z: number } | null;
if (planeM) {
  // Assert the ROTATION, not the bounding box: airplane measures 35.76 x 36,
  // so its footprint is nearly square (wingspan == fuselage) and a box tells
  // you nothing about which way it points. A +x model asked to head +z must
  // turn -90 degrees; the inverted version of this maths turned it +90, which
  // is 180 degrees wrong and exactly what shipped.
  const planeRot = (r.plane as unknown as { rotY: number }).rotY;
  // Test the PROPERTY, not the angle: -90 and 270 are the same turn, and an
  // assertion on the number rather than the effect just fails on the
  // representation. Rotate the model's own facing (+x) by rotation.y and it
  // must land on +z. three.js rotation about Y:
  //   x' = x cos + z sin ; z' = -x sin + z cos
  const landedX = Math.cos(planeRot);
  const landedZ = -Math.sin(planeRot);
  checks.push([
    "a +x model asked to head south actually points +z",
    Math.abs(landedX) < 0.01 && Math.abs(landedZ - 1) < 0.01,
    `rotation.y=${planeRot} turns +x onto (${landedX.toFixed(2)}, ${landedZ.toFixed(2)})`,
  ]);
}
const headings = (r as unknown as { headings?: Record<string, number> }).headings;
if (headings) {
  // heading 0 means travelling +Z (pos.z += cos(0)), so each model must be
  // turned by exactly the offset that puts ITS front on +Z.
  checks.push(["modelHeading: car (-z) offsets by 180 deg", Math.abs(Math.abs(headings.carAt0!) - Math.PI) < 0.01, `${headings.carAt0}`]);
  checks.push(["modelHeading: airplane (+x) offsets by -90 deg", Math.abs(headings.planeAt0! + Math.PI / 2) < 0.01, `${headings.planeAt0}`]);
  checks.push(["modelHeading: dog (+z) needs no offset", Math.abs(headings.dogAt0!) < 0.01, `${headings.dogAt0}`]);
}
// The parts datum, proven on the real object rather than in the table.
if (r.parts) {
  const wheels = (r.parts.list ?? []).filter((p: string) => /wheel/i.test(p));
  checks.push(['modelParts lists the car\'s four wheels', wheels.length === 4, `${wheels.join(', ') || 'none'}`]);
  checks.push(['getObjectByName FINDS a real wheel on the loaded car', r.parts.found === true, r.parts.found ? '' : 'wheel-front-left not found']);
  checks.push(['rotating that wheel actually moves it', r.parts.spun === true, r.parts.spun === null ? 'no wheel to spin' : '']);
}
// The helicopter is the case the primitive-rotor fallback exists for. If this
// ever starts returning parts, the prompt's fallback wording should be revisited.
// The helicopter was rebuilt on 2026-08-23 so it HAS a rotor. What must hold
// now is that the part a game reaches for is the WRAPPER (`rotor`) and never
// the compressor-owned child (`rotor_mesh`).
checks.push(['the helicopter now offers a named rotor', Array.isArray(r.heliParts) && r.heliParts.includes('rotor'), `modelParts("helicopter") = ${JSON.stringify(r.heliParts)}`]);
checks.push(['…and never its internal mesh node', Array.isArray(r.heliParts) && !r.heliParts.some((p: string) => p.endsWith('_mesh')), '']);

// The default orientation: back to the user, bottom on the ground, for every
// model whatever its authored facing.
if (r.bare) {
  for (const name of ["horse", "car", "dog"]) {
    const b = r.bare[name];
    if (!b) { checks.push([`${name} placed with no options`, false, 'placeModel returned null']); continue; }
    checks.push([
      `${name} (authored ${b.facing}) shows its BACK by default`,
      b.frontZ < -0.9,
      `front points z=${b.frontZ} (-1 = away from the viewer)`,
    ]);
    checks.push([`${name} rests on the ground by default`, Math.abs(b.minY) < 0.02, `base y = ${b.minY}`]);
  }
}

// The horse: the owner's actual case, end to end.
const horseReal = entry("horse")?.realSize;
if (r.horse && horseReal) {
  // Compare the LONGEST horizontal extent, not world-z: this horse is asked to
  // head "+x", so after the quarter turn its length lies along x. Measuring z
  // would report its WIDTH and fail a correctly-placed horse (it did).
  const horseLongest = Math.max(r.horse.x, r.horse.z);
  const realLongest = Math.max(horseReal[0]!, horseReal[2]!);
  checks.push([`horse is about ${realLongest}m long`, near(horseLongest, realLongest, realLongest * 0.3), `measured ${horseLongest.toFixed(2)}m`]);
  checks.push(["horse stands on the ground", near(r.horse.minY, 0, 0.02), `base y = ${r.horse.minY}`]);
  // horse is authored +z; asked to head +x it must turn a quarter turn.
  checks.push(["horse asked east turns 90 degrees", near(Math.abs(r.horse.rotY), Math.PI / 2, 0.01), `rotation.y = ${r.horse.rotY}`]);
}
if (r.headingsRide) {
  checks.push(["modelHeading: horse (+z) needs no offset", Math.abs(r.headingsRide.horseAt0!) < 0.01, `${r.headingsRide.horseAt0}`]);
}
if (r.riderRotY !== undefined && r.riderRotY !== null) {
  checks.push(["a +z rider on a +z mount needs no rotation of its own", Math.abs(r.riderRotY) < 0.01, `rider rotation.y = ${r.riderRotY}`]);
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
