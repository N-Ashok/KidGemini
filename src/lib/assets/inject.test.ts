// Injection contract (PRD-3D-GAMES-AND-ASSETS §5b, §11 feature tests):
// unmarked games pass through byte-identical; the USES_THREE marker becomes an
// import map pointing "three" at the engine's immutable asset-host URL; the
// injector is string-concat ONLY — zero file reads, zero network (the Phase-0
// readFileSync-of-an-unshipped-bundle failure class must stay structurally
// impossible, BUG-FIX-LOG 2026-07-08).

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("server-only", () => ({}));

import { THREE_MARKER, injectAssets } from "./inject";
import { ASSET_HOST_ORIGIN, type AssetManifest } from "./manifest";
import realManifest from "./manifest.json";

const ENGINE_SHA = "b".repeat(64);
const testManifest: AssetManifest = {
  assets: [
    {
      name: "three",
      type: "engine",
      url: `${ASSET_HOST_ORIGIN}/three.${ENGINE_SHA.slice(0, 6)}.js`,
      bytes: 559_000,
      license: "MIT",
      sourceUrl: "https://github.com/mrdoob/three.js",
      sha256: ENGINE_SHA,
    },
  ],
};
const ENGINE_URL = testManifest.assets[0]!.url;

function importMapOf(html: string): { imports: Record<string, string> } {
  const m = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
  if (!m) throw new Error("no import map found in output");
  return JSON.parse(m[1]!);
}

describe("injectAssets — plain 2D games are untouched", () => {
  it("returns the html byte-identical when there is no marker", () => {
    const html = "<!doctype html><html><head></head><body>canvas game</body></html>";
    const out = injectAssets(html, testManifest);
    expect(out.html).toBe(html);
    expect(out.referencedUrls).toEqual([]);
  });
});

describe("injectAssets — USES_THREE games get the asset-host engine URL", () => {
  const html = `<!doctype html><html><head><title>Fly</title></head><body>${THREE_MARKER}<script type="module">import { Scene } from "three";</script></body></html>`;
  const out = injectAssets(html, testManifest);

  it("strips the marker comment from the output", () => {
    expect(out.html).not.toContain(THREE_MARKER);
  });

  it("inserts the import map right after <head>, before any game script", () => {
    const headIdx = out.html.indexOf("<head>");
    const mapIdx = out.html.indexOf('<script type="importmap">');
    const titleIdx = out.html.indexOf("<title>");
    expect(mapIdx).toBeGreaterThan(headIdx);
    expect(mapIdx).toBeLessThan(titleIdx);
  });

  it('maps the bare specifier "three" to the engine\'s immutable URL — no base64, no data:', () => {
    const map = importMapOf(out.html);
    expect(map.imports.three).toBe(ENGINE_URL);
    expect(out.html).not.toContain("data:text/javascript");
  });

  it("reports the engine URL in the reference ledger", () => {
    expect(out.referencedUrls).toEqual([ENGINE_URL]);
  });

  it("falls back to inserting right after <html> when there is no <head>", () => {
    const noHead = `<!doctype html><html><body>${THREE_MARKER}<script type="module">go()</script></body></html>`;
    const result = injectAssets(noHead, testManifest);
    const htmlTagEnd = result.html.indexOf("<html>") + "<html>".length;
    expect(result.html.indexOf('<script type="importmap">')).toBe(htmlTagEnd);
  });

  it("prepends when there is neither <head> nor <html> (truncated artifact)", () => {
    const bare = `${THREE_MARKER}<script type="module">go()</script>`;
    const result = injectAssets(bare, testManifest);
    expect(result.html.startsWith('<script type="importmap">')).toBe(true);
  });

  it("throws (for the route's serve-raw fallback) when the manifest has no engine", () => {
    expect(() => injectAssets(html, { assets: [] })).toThrow(/engine/i);
  });
});

describe("injectAssets — the committed manifest is the default", () => {
  it("injects the real engine entry without any argument", () => {
    const engine = realManifest.assets.find((a) => a.type === "engine")!;
    const out = injectAssets(`<html><head></head><body>${THREE_MARKER}</body></html>`);
    expect(importMapOf(out.html).imports.three).toBe(engine.url);
  });
});

describe("injectAssets — structurally zero I/O (PRD §11 structural assertion)", () => {
  const source = readFileSync(join(__dirname, "inject.ts"), "utf8");

  it("the module source performs no file reads and no server-side network", () => {
    // NOTE: the injected BROWSER helper strings may fetch (they run on the
    // kid's device) — what's forbidden is I/O in the injector itself, i.e.
    // on the box at generation time.
    for (const forbidden of ["node:fs", 'from "fs"', "readFileSync", "node:http", "XMLHttpRequest", "await fetch"]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("imports nothing that could do I/O — only server-only, the manifest rules, the manifest JSON, the pure markers module and the pure runtime-helpers", () => {
    const imports = [...source.matchAll(/from "([^"]+)"|import "([^"]+)"/g)]
      .map((m) => m[1] ?? m[2])
      // The helper STRINGS import from "three" inside the game page — those
      // live in template literals, not module scope; filter to line starts.
      .filter((_, i, __) => true);
    const moduleImports = [...source.matchAll(/^import [^;]*?from "([^"]+)";|^import "([^"]+)";/gm)].map((m) => m[1] ?? m[2]);
    // ./markers and ./runtime-helpers are pure (string/regex + template-literal
    // helper builders shared with the client-side floor) — no I/O, so both are
    // legitimate additions to this allowlist.
    expect(moduleImports.sort()).toEqual([
      "./manifest",
      "./manifest.json",
      "./markers",
      "./runtime-helpers",
      "server-only",
    ]);
    expect(imports.length).toBeGreaterThan(0);
  });
});

// ── BUG-FIX-LOG 2026-08-20: the strip predicate ate the child's whole game ───
// Reported as "3D Delhi Elephant Safari is just a blue screen", then "Ari is
// not making it work". ONE root cause, reproduced in a real browser:
// stripInjectedHelperBlocks drops any <script> matching
// `window.(loadModel|loadModelBatch|playSound)\s*=` — and `\s*=` matches the
// FIRST `=` of `===`. A game guarding its optional asset use with the natural
// `if (typeof window.loadModel === 'function')` therefore had its ENTIRE
// module deleted at injection time: UI shell served, canvas never touched,
// sky-blue body showing through. verify-game-html.mjs called it clean, because
// a document with no game in it throws no errors.
//
// The second symptom falls out of the first: the STORED artifact is the
// post-injection one, so an edit turn showed Ari a document with no game code.
// It could not repair what it could not see — hence two EDIT_FAILED_SOFT
// replies in a row on an explicit "debug and fix it".
describe("stripInjectedHelperBlocks — never eats the game (2026-08-20)", () => {
  const game = (body: string) =>
    `<!DOCTYPE html><html><head></head><body><!--USES_THREE-->
<!--USES_MODELS: dog-->
<canvas id="scene"></canvas>
<script type="module">
import { Scene, PerspectiveCamera } from "three";
const scene = new Scene();
${body}
function animate() { requestAnimationFrame(animate); }
animate();
</script></body></html>`;

  const survives = (html: string) => {
    const out = injectAssets(html).html;
    return out.includes("function animate()") && out.includes("Scene, PerspectiveCamera");
  };

  it("keeps a game that feature-detects loadModel with === (the reported bug)", () => {
    expect(survives(game(`if (typeof window.loadModel === 'function') { window.loadModel("dog"); }`))).toBe(true);
  });

  it("keeps a game that feature-detects with ==", () => {
    expect(survives(game(`if (window.loadModel == null) { console.log("no models"); }`))).toBe(true);
  });

  it("keeps a game that feature-detects loadModelBatch and playSound", () => {
    expect(survives(game(`if (typeof window.loadModelBatch === 'function') {}
if (typeof window.playSound === 'function') window.playSound("pop");`))).toBe(true);
  });

  it("keeps a game that merely CALLS the helpers", () => {
    expect(survives(game(`window.loadModel("elephant").then(m => scene.add(m));`))).toBe(true);
  });

  it("STILL strips a genuine echoed helper assignment — the reason this exists", () => {
    const echoed = `<!DOCTYPE html><html><body><!--USES_THREE-->
<script>window.__arLoadModelVersion = 1; window.loadModel = async function (n) { return null; };</script>
<script type="module">
import { Scene, PerspectiveCamera } from "three";
function animate() { requestAnimationFrame(animate); }
</script></body></html>`;
    const out = injectAssets(echoed).html;
    expect(out).not.toContain("return null; };"); // the stale helper is gone
    expect(out).toContain("function animate()"); // the game is not
  });
});
