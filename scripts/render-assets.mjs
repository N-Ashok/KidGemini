// Render published assets top-down so a HUMAN can see what no number reveals
// (2026-08-09 — docs/2026-08-08_PRD_AssetFitnessAndReview.md, Step 0a).
//
// WHY THIS EXISTS. The "poorly formed race track" bug came down to one
// question — WHICH EDGES DOES A CORNER TILE JOIN? — and it is not answerable
// from the bytes. These Kenney road tiles are flat single-material slabs with
// the carriageway painted into the `colormap` texture, so the geometry is a
// rectangle whichever way the road runs. Two independent geometric probes were
// tried (extrusion uniformity, raised-kerb runs) and BOTH returned "(none)".
// The only instrument that answers it is an eye. This is that instrument.
//
// It renders the asset EXACTLY as a kid's game does — dynamic import() of the
// vendored three bundle from assets.ariantra.com, GLTFLoader + MeshoptDecoder
// — the same three calls loadModelHelper() makes. Same path, same bytes, so
// what you see is what a child gets.
//
// Top-down orthographic, framed to the model's own XZ footprint, with the four
// world edges labelled. The image is a MAP: screen-right is +X and screen-UP
// is -Z (three's convention for a camera at +Y with up = -Z).
//
// Prereqs: `playwright-core` resolvable (npm i, or PLAYWRIGHT_CORE_DIR=...),
// and the Playwright chromium-headless-shell cache. Network access to
// assets.ariantra.com. Nothing runs on the EC2 box (docs/MEMORY_BUDGET.md).
//
//   node scripts/render-assets.mjs road_curve race_track_corner
//   node scripts/render-assets.mjs --out /tmp/shots road_curve
//   node scripts/render-assets.mjs --side road_curve      # 3/4 view as well
import { readdirSync, readFileSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(repo, "src/lib/assets/manifest.json"), "utf8"));

const argv = process.argv.slice(2);
const wantSide = argv.includes("--side");
const outIdx = argv.indexOf("--out");
const outDir = outIdx >= 0 ? argv[outIdx + 1] : join(repo, ".asset-renders");
// Skip flags AND the value that follows a value-taking flag, or "--out DIR"
// would silently be read as a model name and fail with a confusing error.
const valueSlots = new Set([outIdx, argv.indexOf("--json")].filter((i) => i >= 0).map((i) => i + 1));
const names = argv.filter((a, i) => !a.startsWith("--") && !valueSlots.has(i));

if (names.length === 0) {
  console.error("usage: node scripts/render-assets.mjs [--out DIR] [--side] <model-name>...");
  process.exit(1);
}

// By NAME, never by type — the host serves two engine-type bundles since
// 2026-07-29 (three + cannon), so find(type === "engine") is a coin toss.
const engine = manifest.assets.find((a) => a.type === "engine" && a.name === "three");
if (!engine) throw new Error("manifest has no three engine entry — run scripts/vendor-three.mjs --upload");

// --staged: render the compressed bytes sitting in .assets-out/models instead
// of the published ones (2026-08-09). A new batch cannot be eyeballed any
// other way — it has no manifest entry and no URL until it is uploaded, and
// uploading to the append-only host is exactly the step that must NOT happen
// before a human has looked (PRD §10: published bytes are permanent). Same
// loader, same decoder, same bytes that will be uploaded — only the origin
// differs.
const staged = argv.includes("--staged");
const stagedFiles = staged
  ? readdirSync(join(repo, ".assets-out/models")).filter((f) => f.endsWith(".glb"))
  : [];

const targets = names.map((name) => {
  if (staged) {
    // Hash-named at birth: "elephant.b19a33.glb" for "elephant".
    // NEWEST match, not the first: staging is hash-named and append-only on
    // disk, so re-running the pipeline after an edit leaves BOTH builds there.
    // Taking the first silently rendered the pre-edit mesh and reported it as
    // the fix — a lying instrument is worse than none (caught 2026-08-09 when
    // a re-rendered snow_mountain came back byte-identical to its own bug).
    const file = stagedFiles
      .filter((f) => f.slice(0, f.indexOf(".")) === name)
      .map((f) => ({ f, mtime: statSync(join(repo, ".assets-out/models", f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)[0]?.f;
    if (!file) throw new Error(`no staged build for "${name}" — run scripts/vendor-models.mjs --only=${name} first`);
    // Handed to the page as base64, not as a file:// URL: the render page is
    // an about:blank setContent document, and fetching file:// from it is
    // blocked. The page rebuilds a blob: URL, so the loader still fetches a
    // real URL exactly as it does in a kid's game.
    return { name, url: null, b64: readFileSync(join(repo, ".assets-out/models", file)).toString("base64"), size: null };
  }
  const entry = manifest.assets.find((a) => a.name === name && a.type === "model");
  if (!entry) throw new Error(`no model named "${name}" in the manifest — check the spelling, do not guess`);
  return { name, url: entry.url, size: entry.size ?? null };
});

const chromium = await (async () => {
  try {
    return (await import("playwright-core")).chromium;
  } catch {
    const dir = process.env.PLAYWRIGHT_CORE_DIR;
    if (!dir) throw new Error("playwright-core not installed — npm i playwright-core or set PLAYWRIGHT_CORE_DIR");
    return (await import(pathToFileURL(`${dir}/index.mjs`).href)).chromium;
  }
})();

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`;
const shell = readdirSync(cache).find((d) => d.startsWith("chromium_headless_shell-"));
if (!shell) throw new Error("no chromium_headless_shell in playwright cache");
const EXE = `${cache}/${shell}/chrome-headless-shell-mac-arm64/chrome-headless-shell`;

mkdirSync(outDir, { recursive: true });

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:#f4f4f4;font:13px system-ui,sans-serif;color:#222}
  canvas{display:block}
</style></head><body></body></html>`;

const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 700, height: 760 }, deviceScaleFactor: 2 });
page.on("console", (m) => { if (m.type() === "error") console.error("  [browser]", m.text()); });
await page.setContent(PAGE);

// Everything below runs IN THE PAGE, against the real engine bundle.
const shots = await page.evaluate(
  async ({ engineUrl, targets, wantSide }) => {
    const T = await import(engineUrl);
    const loader = new T.GLTFLoader();
    loader.setMeshoptDecoder(T.MeshoptDecoder);

    const SIZE = 640;
    const results = [];

    for (const t of targets) {
      let url = t.url;
      if (t.b64) {
        const bin = atob(t.b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        url = URL.createObjectURL(new Blob([bytes], { type: "model/gltf-binary" }));
      }
      const gltf = await loader.loadAsync(url);
      const obj = gltf.scene;
      const box = new T.Box3().setFromObject(obj);
      const size = box.getSize(new T.Vector3());
      const center = box.getCenter(new T.Vector3());

      const views = [{ key: "top", side: false }, ...(wantSide ? [{ key: "iso", side: true }] : [])];
      for (const view of views) {
        const scene = new T.Scene();
        scene.background = new T.Color(0xf4f4f4);
        const group = new T.Group();
        // Centre on XZ only — keep Y as authored so a tile's thickness and a
        // prop's height read truthfully rather than being floated to the middle.
        obj.position.set(-center.x, -box.min.y, -center.z);
        group.add(obj);
        scene.add(group);
        scene.add(new T.AmbientLight(0xffffff, 0.95));
        const sun = new T.DirectionalLight(0xffffff, 1.1);
        sun.position.set(2, 6, 3);
        scene.add(sun);

        // Pad by 12% so the tile edges are visibly INSIDE the frame — a road
        // that runs to the very edge must be distinguishable from one that
        // stops short, which is the whole point of the exercise.
        const span = Math.max(size.x, size.z) * 1.12 || 1;
        let cam;
        if (!view.side) {
          // A LONG LENS, not an orthographic camera: the vendored bundle's
          // export list is curated and has no OrthographicCamera (a kid's game
          // cannot use one either — scripts/vendor-three.mjs). A 5-degree FOV
          // pulled back to suit leaves perspective distortion far below the
          // precision this instrument is read at, and keeps the harness on
          // exactly the API surface a game has.
          const FOV = 5;
          cam = new T.PerspectiveCamera(FOV, 1, 0.01, 2000);
          const d = span / 2 / Math.tan((FOV / 2) * (Math.PI / 180));
          cam.position.set(0, d, 0);
          cam.up.set(0, 0, -1); // screen-up = -Z, screen-right = +X
          cam.lookAt(0, 0, 0);
        } else {
          // Far plane scaled to the camera distance, not a fixed 200 m: the
          // poly.pizza archive ships models at wild author scales (an elephant
          // measuring 264 m), and a fixed far plane clipped them away entirely
          // — the render came back BLANK and looked like a broken model rather
          // than a framing bug (2026-08-09).
          cam = new T.PerspectiveCamera(35, 1, 0.01, 1);
          // The 3/4 view must include HEIGHT in its framing: `span` is the XZ
          // footprint, which is the right frame for a flat road tile and the
          // wrong one for a 7.5 m lift tower or an upright monkey — those were
          // cropped to an unreadable close-up (2026-08-09). Top view keeps the
          // footprint framing: it is a map and height is not in it.
          const d = Math.max(span, size.y * 1.15) * 1.9;
          cam.near = Math.max(0.01, d / 1000);
          cam.far = d * 10;
          cam.updateProjectionMatrix();
          cam.position.set(d * 0.6, d * 0.75, d * 0.6);
          cam.lookAt(0, size.y / 2, 0);
        }

        const renderer = new T.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
        renderer.setSize(SIZE, SIZE, false);
        renderer.render(scene, cam);

        // Compose onto a labelled 2D canvas: the render plus the world-axis
        // legend and the measured metres. A bare picture of a grey slab is
        // useless three days later; the numbers make it evidence.
        const c = document.createElement("canvas");
        c.width = SIZE + 60;
        c.height = SIZE + 100;
        const g = c.getContext("2d");
        g.fillStyle = "#f4f4f4";
        g.fillRect(0, 0, c.width, c.height);
        g.drawImage(renderer.domElement, 30, 56, SIZE, SIZE);
        g.strokeStyle = "#c00";
        g.setLineDash([6, 5]);
        g.strokeRect(30, 56, SIZE, SIZE); // the framed footprint + 12% padding
        g.setLineDash([]);
        g.fillStyle = "#111";
        g.font = "bold 20px system-ui, sans-serif";
        g.fillText(`${t.name}  —  ${view.key === "top" ? "TOP-DOWN (map view)" : "3/4 view"}`, 30, 26);
        g.font = "15px system-ui, sans-serif";
        const dims = `${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)} m  (X x Y x Z)`;
        g.fillText(dims, 30, 46);
        if (view.key === "top") {
          g.font = "bold 17px system-ui, sans-serif";
          g.fillStyle = "#0a6";
          g.fillText("-Z (north)", SIZE / 2 - 5, 52);
          g.fillText("+Z (south)", SIZE / 2 - 5, SIZE + 78);
          g.save();
          g.translate(20, SIZE / 2 + 56);
          g.rotate(-Math.PI / 2);
          g.fillText("-X (west)", -30, 0);
          g.restore();
          g.save();
          g.translate(SIZE + 48, SIZE / 2 + 56);
          g.rotate(-Math.PI / 2);
          g.fillText("+X (east)", -30, 0);
          g.restore();
        }
        // --- Edge probe -------------------------------------------------
        // The geometry cannot say which edges a tile joins, but the RENDER
        // can: the carriageway is painted into the colormap, so it is visible
        // even on a flat slab. Sample one pixel row/column just inside each
        // world edge and classify. "Drivable" = achromatic and mid-dark:
        // tarmac is grey in the racing kit and blue-slate in the city kit
        // (both low saturation), while grass is saturated green, and kerb,
        // lane paint and the page background are all near-white. Deliberately
        // conservative — it answers "does road reach this edge", not "what
        // shade of tarmac", so a new kit does not need new thresholds.
        let edges = null;
        if (view.key === "top") {
          const px = renderer.domElement;
          const rc = document.createElement("canvas");
          rc.width = SIZE;
          rc.height = SIZE;
          const rg = rc.getContext("2d");
          rg.drawImage(px, 0, 0);
          const data = rg.getImageData(0, 0, SIZE, SIZE).data;
          // The frame carries 12% padding, so the model's own footprint is the
          // central SIZE/1.12. Probe 2px inside it — dead on the boundary can
          // catch an antialiased half-pixel of background.
          const pad = Math.round((SIZE * (1 - 1 / 1.12)) / 2);
          const lo = pad + 2;
          const hi = SIZE - pad - 3;
          // Tarmac is grey in the racing kit and BLUE-slate in the city kit, so
          // a saturation cap alone cannot separate it from grass (measured:
          // city tarmac ~0.18-0.21, grass ~0.27 — they overlap). Green
          // DOMINANCE does separate them cleanly, in both kits and in every
          // road texture Kenney ships: grass has g as its max channel, tarmac
          // never does. Kerb, lane paint and the page background are all
          // excluded by brightness.
          const drivable = (x, y) => {
            const i = (y * SIZE + x) * 4;
            const r = data[i], g = data[i + 1], b = data[i + 2];
            const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
            const sat = mx === 0 ? 0 : (mx - mn) / mx;
            const greenDominant = g > r && g > b;
            return !greenDominant && sat < 0.35 && mx > 38 && mx < 195;
          };
          const scan = (fn) => {
            const hits = [];
            for (let k = lo; k <= hi; k++) if (fn(k)) hits.push(k);
            const span = hi - lo || 1;
            return hits.length
              ? {
                  coverage: +(hits.length / (span + 1)).toFixed(3),
                  from: +((hits[0] - lo) / span).toFixed(3),
                  to: +((hits[hits.length - 1] - lo) / span).toFixed(3),
                }
              : { coverage: 0, from: null, to: null };
          };
          // Screen-up is -Z and screen-right is +X (camera up = (0,0,-1)).
          edges = {
            "-z": scan((x) => drivable(x, lo)),
            "+z": scan((x) => drivable(x, hi)),
            "-x": scan((y) => drivable(lo, y)),
            "+x": scan((y) => drivable(hi, y)),
          };
        }
        results.push({ name: t.name, view: view.key, png: c.toDataURL("image/png"), edges, size: [size.x, size.y, size.z] });
        renderer.dispose();
        group.remove(obj);
      }
    }
    return results;
  },
  { engineUrl: engine.url, targets, wantSide },
);

for (const s of shots) {
  const file = join(outDir, `${s.name}.${s.view}.png`);
  writeFileSync(file, Buffer.from(s.png.split(",")[1], "base64"));
  console.log("  wrote", file);
  if (!s.edges) continue;
  console.log(`        ${describe(s)}`);
}

/**
 * Turn the raw fractional scan into METRES. Fractions are not comparable
 * across pieces — this is the finish_line lesson: it reads 35% against
 * race_track_straight's 70% and looks like a mismatch, but the frame spans the
 * piece's LONGEST side (2 m vs 1 m), so both are the same 0.70 m carriageway.
 * Carriageway width in metres is the number that says whether two pieces mate.
 */
function describe(s) {
  const [sx, , sz] = s.size;
  const frame = Math.max(sx, sz); // the scan axis spans this many metres
  const carrying = Object.entries(s.edges).filter(([, e]) => e.coverage > 0.02);
  if (!carrying.length) return "joins: (none — not a path piece)";
  const lines = [`joins: ${carrying.map(([k]) => k).join(" + ")}`];
  for (const [k, e] of carrying) {
    // The model is centred in the frame, so convert a frame fraction to a
    // distance from the piece's own minimum on the scanned axis.
    const own = k === "-x" || k === "+x" ? sz : sx;
    const inset = (frame - own) / 2;
    const width = e.coverage * frame;
    const mid = ((e.from + e.to) / 2) * frame - inset;
    const offCentre = mid - own / 2;
    lines.push(
      `  ${k.padEnd(3)} carriageway ${width.toFixed(2)}m` +
        `   centred ${Math.abs(offCentre) < 0.02 ? "yes" : `NO (${offCentre > 0 ? "+" : ""}${offCentre.toFixed(2)}m)`}`,
    );
  }
  return lines.join("\n        ");
}

// Machine-readable measurements for scripts/backfill-tile-edges.mjs. Kept as a
// separate artifact rather than written straight into the manifest: measuring
// needs a browser and a network, and the manifest write must stay a small,
// reviewable, re-runnable step (the backfill-path-axis.mjs precedent).
const jsonIdx = argv.indexOf("--json");
if (jsonIdx >= 0) {
  const measured = {};
  for (const s of shots) {
    if (!s.edges) continue;
    const [sx, , sz] = s.size;
    const frame = Math.max(sx, sz);
    const joins = [];
    const offsets = {};
    let lane = 0;
    for (const [k, e] of Object.entries(s.edges)) {
      if (e.coverage <= 0.02) continue;
      joins.push(k);
      lane = Math.max(lane, +(e.coverage * frame).toFixed(3));
      // WHERE along the edge the carriageway sits, in metres from the piece's
      // own minimum on the scanned axis. Edge NAMES alone cannot tell a valid
      // two-cell sweeping turn (road_curve: joins at 0.5 m and 1.5 m on a 2 m
      // tile — both cell centres) from the racing chicane (joins at 0.5 m and
      // 1.0 m — the second is off-grid, so no on-grid straight can follow it).
      const own = k === "-x" || k === "+x" ? sz : sx;
      const inset = (frame - own) / 2;
      offsets[k] = +(((e.from + e.to) / 2) * frame - inset).toFixed(3);
    }
    measured[s.name] = { joins, offsets, lane, size: s.size.map((n) => +n.toFixed(3)) };
  }
  writeFileSync(argv[jsonIdx + 1], JSON.stringify(measured, null, 2) + "\n");
  console.log("  wrote", argv[jsonIdx + 1]);
}

await browser.close();
console.log(`\n${shots.length} render(s) in ${outDir}`);
