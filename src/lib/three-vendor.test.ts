import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { THREE_MARKER, injectThreeJsIfNeeded } from "./three-vendor";

function decodeImportMap(html: string): { imports: Record<string, string> } {
  const m = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
  if (!m) throw new Error("no import map found in output");
  return JSON.parse(m[1]!);
}

describe("injectThreeJsIfNeeded — plain 2D games are untouched", () => {
  it("returns the html unchanged when there is no USES_THREE marker", () => {
    const html = "<!doctype html><html><head></head><body>canvas game</body></html>";
    expect(injectThreeJsIfNeeded(html)).toBe(html);
  });
});

describe("injectThreeJsIfNeeded — 3D games get a self-contained Three.js", () => {
  const html = `<!doctype html><html><head><title>Fly</title></head><body>${THREE_MARKER}<script type="module">import * as THREE from "three";</script></body></html>`;
  const out = injectThreeJsIfNeeded(html);

  it("strips the marker comment from the output", () => {
    expect(out).not.toContain(THREE_MARKER);
  });

  it("inserts a <script type=importmap> right after <head>, before <title>", () => {
    const headIdx = out.indexOf("<head>");
    const mapIdx = out.indexOf('<script type="importmap">');
    const titleIdx = out.indexOf("<title>");
    expect(mapIdx).toBeGreaterThan(headIdx);
    expect(mapIdx).toBeLessThan(titleIdx);
  });

  it("maps the bare specifier \"three\" to a self-contained data: URI module", () => {
    const map = decodeImportMap(out);
    expect(map.imports.three).toMatch(/^data:text\/javascript;base64,/);
  });

  it("the embedded bundle decodes to real, usable Three.js exports", () => {
    const map = decodeImportMap(out);
    const three = map.imports.three!;
    expect(three).toMatch(/^data:text\/javascript;base64,/);
    const base64 = three.split("base64,")[1]!;
    const source = Buffer.from(base64, "base64").toString("utf8");
    // A tree-shaken bundle, not a raw copy — no relative imports left to break
    // once loaded from a data: URI (see scripts/vendor-three.mjs for why).
    expect(source).not.toMatch(/from *["']\.\//);
    for (const name of ["PerspectiveCamera", "WebGLRenderer", "BoxGeometry", "MeshStandardMaterial", "Scene"]) {
      expect(source).toContain(name);
    }
  });

  it("falls back to inserting right after <html> when there is no <head>", () => {
    const noHead = `<!doctype html><html><body>${THREE_MARKER}<script type="module">go()</script></body></html>`;
    const result = injectThreeJsIfNeeded(noHead);
    const htmlTagEnd = result.indexOf("<html>") + "<html>".length;
    expect(result.indexOf('<script type="importmap">')).toBe(htmlTagEnd);
  });
});
