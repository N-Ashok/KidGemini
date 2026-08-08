// Run a generated game IN A REAL BROWSER and report whether it actually works.
//
// WHY THIS EXISTS (2026-08-09, after a production outage). Every test in this
// repo asserts on STRINGS inside the generated HTML — `expect(html).toContain(
// "importmap")`. 2,190 of them were green while 3D games were broken in
// production, because "the import map is present" and "the import map still
// resolves `three` at runtime" are different claims and only the first was
// ever tested. A strip regex that destroyed the document was invisible to all
// of them, since the injector re-emits the strings moments later.
//
// This is the missing half: load the page, let the module graph resolve, and
// listen. It catches the whole class — broken document structure, a helper
// that vanished, an asset URL that 404s, a script that throws on first frame.
//
// FAITHFUL TO PRODUCTION: the game is loaded into an IFRAME via `srcdoc`,
// which is how the preview and the published page run it — the live error
// report said `about:srcdoc`, and module-specifier resolution differs between
// srcdoc and a normal document. Testing it any other way would test something
// the child never runs.
//
// Reads real bytes from assets.ariantra.com, so it also dogfoods the immutable
// host: if the engine or a model URL is wrong, this says so.
//
// Prereqs: `playwright-core` resolvable (npm i, or PLAYWRIGHT_CORE_DIR=...),
// the Playwright chromium cache, and network access.
//
//   node scripts/verify-game-html.mjs game.html [more.html ...]
//   node scripts/verify-game-html.mjs --json report.json game.html
//   node scripts/verify-game-html.mjs --settle 6000 game.html   # slow models
//
// Exit code 0 = every file clean, 1 = at least one failed. Safe for CI.

import { readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const jsonIdx = argv.indexOf("--json");
const settleIdx = argv.indexOf("--settle");
const SETTLE_MS = settleIdx >= 0 ? Number(argv[settleIdx + 1]) : 4500;
const valueSlots = new Set([jsonIdx, settleIdx].filter((i) => i >= 0).map((i) => i + 1));
const files = argv.filter((a, i) => !a.startsWith("--") && !valueSlots.has(i));

if (files.length === 0) {
  console.error("usage: node scripts/verify-game-html.mjs [--json OUT] [--settle MS] <game.html>...");
  process.exit(1);
}

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

// Noise a healthy game legitimately produces. Deliberately SHORT: every entry
// is a hole in the net, and the outage this script exists for announced itself
// as a plain console error. WebGL performance hints are the only genuine
// false positive seen so far — they fired on the broken game too.
const BENIGN = [
  /WebGL.*performance/i,
  /GPU stall/i,
  /Automatic fallback to software WebGL/i,
  /THREE\.WebGLRenderer: Context Lost/i,
];
const isBenign = (text) => BENIGN.some((re) => re.test(text));

const browser = await chromium.launch({
  executablePath: EXE,
  // The kid's game needs real GL; headless-shell falls back to SwiftShader.
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});

const results = [];
for (const file of files) {
  const html = readFileSync(file, "utf8");
  const page = await browser.newPage({ viewport: { width: 1024, height: 720 } });
  const errors = [];
  const badResponses = [];

  // Uncaught exceptions and console errors, from EVERY frame — the game runs
  // inside the iframe, so a page-level listener alone would see nothing.
  page.on("pageerror", (e) => errors.push({ kind: "pageerror", text: String(e.message || e) }));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    if (!isBenign(text)) errors.push({ kind: "console", text });
  });
  page.on("requestfailed", (r) => {
    const u = r.url();
    if (u.startsWith("data:") || u.startsWith("about:")) return;
    badResponses.push({ url: u, status: "failed", why: r.failure()?.errorText ?? "unknown" });
  });
  page.on("response", (r) => {
    if (r.status() >= 400) badResponses.push({ url: r.url(), status: r.status() });
  });

  await page.setContent(`<!doctype html><html><body style="margin:0"><iframe id="g" style="width:100%;height:100%;border:0"></iframe></body></html>`);
  await page.evaluate((doc) => {
    document.getElementById("g").srcdoc = doc;
  }, html);

  // Fixed settle rather than a load event: module graphs, GLB fetches and the
  // first animation frame all land after load, and the faults worth catching
  // (a model that never resolves, a helper that is not defined when the game
  // calls it) happen exactly there.
  await page.waitForTimeout(SETTLE_MS);

  // Ask the frame what actually exists. String assertions cannot answer these:
  // the injector re-emits every one of these names into the HTML even when the
  // document that reaches the browser is broken.
  const probe = await page
    .evaluate(() => {
      const w = document.getElementById("g").contentWindow;
      const count = (o) => (o && typeof o === "object" ? Object.keys(o).length : 0);
      return {
        loadModel: typeof w.loadModel,
        modelSize: typeof w.modelSize,
        modelJoins: typeof w.modelJoins,
        rotateToJoin: typeof w.rotateToJoin,
        assets: count(w.AR_ASSETS),
        sizes: count(w.AR_SIZES),
        edges: count(w.AR_EDGES),
        helperVersion: w.__arLoadModelVersion ?? null,
        canvases: w.document.querySelectorAll("canvas").length,
      };
    })
    .catch((e) => ({ probeError: String(e.message || e) }));

  const usesModels = /loadModel\s*\(/.test(html);
  const failures = [];
  for (const e of errors) failures.push(`${e.kind}: ${e.text}`);
  for (const r of badResponses) failures.push(`asset ${r.status}: ${r.url}${r.why ? ` (${r.why})` : ""}`);
  if (probe.probeError) failures.push(`could not read the frame: ${probe.probeError}`);
  else if (usesModels) {
    // The three the outage broke, asserted against the LIVE window rather than
    // against the markup that claims to define them.
    if (probe.loadModel !== "function") failures.push("window.loadModel is not defined — the helper never ran");
    if (probe.assets === 0) failures.push("window.AR_ASSETS is empty — no model URL reached the game");
    if (probe.canvases === 0) failures.push("no <canvas> was created — the game never rendered");
  }

  results.push({ file: basename(file), ok: failures.length === 0, failures, probe });
  await page.close();
}

await browser.close();

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? "✓" : "✖"} ${r.file}`);
  if (r.probe && !r.probe.probeError) {
    console.log(
      `    loadModel:${r.probe.loadModel} joins:${r.probe.modelJoins} helper:v${r.probe.helperVersion} ` +
        `assets:${r.probe.assets} sizes:${r.probe.sizes} edges:${r.probe.edges} canvas:${r.probe.canvases}`,
    );
  }
  for (const f of r.failures) console.log(`    - ${f}`);
  if (!r.ok) failed++;
}
if (jsonIdx >= 0) writeFileSync(argv[jsonIdx + 1], JSON.stringify(results, null, 2) + "\n");

console.log(`\n${results.length - failed}/${results.length} game(s) run clean`);
process.exit(failed > 0 ? 1 : 0);
