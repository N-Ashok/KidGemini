// Asset-marker helpers — the primitives behind the inSource=false rescue
// (KNOWN_BUGS #5). stripAssetMarkers MUST remove markers byte-for-byte the way
// injectAssets does, or a reconciled SEARCH still won't match the stored source.
import { describe, expect, it } from "vitest";
import {
  arAssetsKeys, assetMarkerNames, hasAssetMarker, looksInjected, stripAssetMarkers,
  THREE_MARKER, MODELS_MARKER_RE, AUDIO_MARKER_RE,
} from "./markers";
import { injectAssets } from "./inject";

describe("stripAssetMarkers", () => {
  it("M.1 removes USES_THREE / USES_MODELS / USES_AUDIO, leaving surrounding text", () => {
    const src = `<body>\n${THREE_MARKER}\n<!--USES_MODELS: car, tree-->\n<!--USES_AUDIO: jump-->\n<canvas></canvas>`;
    const out = stripAssetMarkers(src);
    expect(out).not.toMatch(/USES_/);
    expect(out).toContain("<canvas></canvas>");
    // whitespace around the marker is untouched (matches injectAssets exactly)
    expect(out).toBe("<body>\n\n\n\n<canvas></canvas>");
  });

  it("M.2 is byte-identical to how injectAssets strips markers from the body", () => {
    // The stored game's body region must equal stripAssetMarkers(originalBody),
    // or a reconciled SEARCH block would still miss by a stray newline.
    const html = `<!doctype html><html><head></head><body>${THREE_MARKER}<!--USES_MODELS: car--><canvas></canvas></body></html>`;
    const injected = injectAssets(html).html;
    // Body after the injected <head> markup is exactly the marker-stripped body.
    expect(injected).toContain(stripAssetMarkers(`<body>${THREE_MARKER}<!--USES_MODELS: car--><canvas></canvas></body>`));
  });

  it("M.3 leaves a marker-free game unchanged (identity)", () => {
    const src = "<html><body><canvas></canvas></body></html>";
    expect(stripAssetMarkers(src)).toBe(src);
  });
});

describe("hasAssetMarker / assetMarkerNames", () => {
  it("M.4 detects any marker; a plain game has none", () => {
    expect(hasAssetMarker(`x${THREE_MARKER}y`)).toBe(true);
    expect(hasAssetMarker("<!--USES_MODELS: car-->")).toBe(true);
    expect(hasAssetMarker("<html></html>")).toBe(false);
  });

  it("M.5 collects lower-cased, de-duped names from models + audio (THREE has none)", () => {
    const src = `${THREE_MARKER}<!--USES_MODELS: Car, tree, car--><!--USES_AUDIO: jump-->`;
    expect(assetMarkerNames(src)).toEqual(["car", "tree", "jump"]);
  });

  it("M.6 global regexes are not left with a dangling lastIndex between calls", () => {
    const src = "<!--USES_MODELS: car--><!--USES_AUDIO: jump-->";
    // Two calls in a row must return the same thing — a leaked lastIndex would
    // make the second call skip the leading match.
    expect(assetMarkerNames(src)).toEqual(assetMarkerNames(src));
    expect(MODELS_MARKER_RE.lastIndex).toBe(0);
    expect(AUDIO_MARKER_RE.lastIndex).toBe(0);
  });
});

describe("looksInjected / arAssetsKeys", () => {
  it("M.7 an injected models game reports its AR_ASSETS keys and reads as injected", () => {
    const html = `<!doctype html><html><head></head><body><!--USES_MODELS: car, tree--><canvas></canvas></body></html>`;
    const injected = injectAssets(html).html;
    expect(looksInjected(injected)).toBe(true);
    expect(arAssetsKeys(injected).sort()).toEqual(["car", "tree"]);
  });

  it("M.8 a plain 2D game is not injected and has no AR_ASSETS", () => {
    const html = "<html><body><canvas></canvas></body></html>";
    expect(looksInjected(html)).toBe(false);
    expect(arAssetsKeys(html)).toEqual([]);
  });

  it("M.9 a THREE-only game (import map, no models) still reads as injected", () => {
    const html = `<!doctype html><html><head></head><body>${THREE_MARKER}<script type="module">import { Scene } from "three";</script></body></html>`;
    expect(looksInjected(injectAssets(html).html)).toBe(true);
  });
});
