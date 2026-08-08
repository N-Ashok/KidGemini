// STRUCTURAL INVARIANT for every injected runtime table.
//
// Written 2026-08-09 after a production outage: the AR_EDGES strip regex
// shipped GREEDY — `(\{[\s\S]*\})` — so it ran past its own block's
// `</script>` to the LAST `}`+`</script>` anywhere in the document, deleting
// the loadModel helper on the way. Live errors: "loadModel is not defined" and
// "Failed to resolve module specifier three". Every existing test stayed green,
// because they all assert `toContain` on strings that the injector re-emits
// moments later — so a strip that destroyed the document was invisible.
//
// This file tests the OPPOSITE property, and it is the one that matters:
//
//   strip_X(doc) must equal doc with block X removed AND NOTHING ELSE.
//
// Byte-exact, not "the important bits survive". That generalises past the one
// regex that broke: any future table, and any future edit to an existing one,
// is held to it. The four regexes are near-identical by design, so a fault in
// one is a fault waiting in all of them.
//
// The document below is deliberately hostile in the exact way a real generated
// game is, and in the way three of my own first attempts at a regression test
// were NOT — those fixtures passed against the broken code because their
// script blocks did not end with a closing brace.

import { describe, expect, it } from "vitest";
import {
  stripAssetTables,
  stripSizeTables,
  stripAxisTables,
  stripEdgeTables,
  countAssetTables,
  countSizeTables,
  countAxisTables,
  countEdgeTables,
  parseAssetTables,
  parseSizeTables,
  parseAxisTables,
  parseEdgeTables,
} from "./runtime-helpers";

const IMPORTMAP = `<script type="importmap">{"imports":{"three":"https://assets.ariantra.com/three.abc123.js"}}</script>`;
const AR_ASSETS = `<script>window.AR_ASSETS={"race_track_corner":"https://assets.ariantra.com/race_track_corner.aa11bb.glb"};</script>`;
const AR_SIZES = `<script>window.AR_SIZES={"race_track_corner":[1,0.02,1]};</script>`;
const AR_AXES = `<script>window.AR_AXES={"race_track_corner":"none"};</script>`;
// NESTED objects — the shape that tempted a greedy quantifier in the first place.
const AR_EDGES = `<script>window.AR_EDGES={"race_track_corner":{"joins":["+z","+x"],"lane":0.697,"at":{"+z":0.5,"+x":0.5}}};</script>`;
const HELPER = `<script type="module">
  import { GLTFLoader } from "three";
  window.__arLoadModelVersion = 6;
window.loadModel = async function (name) { return null; };
</script>`;
// Ends with `}` immediately before `</script>` — the detail that decides how far
// a greedy match reaches, and how essentially every generated game ends.
const GAME = `<script type="module">
import { Scene } from "three";
function createTrack() {
  loadModel("race_track_corner");
}
createTrack();
</script>`;

const DOC = `<!doctype html><html><head></head><body>${IMPORTMAP}${AR_ASSETS}${AR_SIZES}${AR_AXES}${AR_EDGES}${HELPER}${GAME}</body></html>`;

const TABLES = [
  { name: "AR_ASSETS", block: AR_ASSETS, strip: stripAssetTables, count: countAssetTables, parse: parseAssetTables },
  { name: "AR_SIZES", block: AR_SIZES, strip: stripSizeTables, count: countSizeTables, parse: parseSizeTables },
  { name: "AR_AXES", block: AR_AXES, strip: stripAxisTables, count: countAxisTables, parse: parseAxisTables },
  { name: "AR_EDGES", block: AR_EDGES, strip: stripEdgeTables, count: countEdgeTables, parse: parseEdgeTables },
] as const;

describe.each(TABLES)("$name — strip removes its own block and nothing else", ({ name, block, strip, count, parse }) => {
  it("is byte-exact: the result equals the document minus exactly that block", () => {
    // The single assertion that would have caught the outage. Everything else
    // in this file is a more legible restatement of it.
    expect(strip(DOC)).toBe(DOC.replace(block, ""));
  });

  it("leaves the import map intact — a stripped map means `three` stops resolving", () => {
    expect(strip(DOC)).toContain('<script type="importmap">');
  });

  it("leaves the loadModel helper intact", () => {
    expect(strip(DOC)).toContain("window.loadModel = async function");
    expect(strip(DOC)).toContain("__arLoadModelVersion = 6");
  });

  it("leaves the CHILD'S OWN game code intact — this is what 'the whole track vanished' means", () => {
    const out = strip(DOC);
    expect(out).toContain("function createTrack()");
    expect(out).toContain('loadModel("race_track_corner")');
    expect(out).toContain("createTrack();");
  });

  it("leaves the other three tables intact", () => {
    const out = strip(DOC);
    for (const other of TABLES) {
      if (other.name === name) continue;
      expect(out, `${name} strip destroyed ${other.name}`).toContain(other.block);
    }
  });

  it("counts exactly one block, and parses it back to a real object", () => {
    // The greedy capture swallowed trailing markup and threw inside the
    // fail-soft catch, so the table read as ABSENT rather than as corrupt.
    // A silent parse failure is how this stayed invisible.
    expect(count(DOC)).toBe(1);
    const parsed = parse(DOC);
    expect(parsed).toHaveLength(1);
    expect(Object.keys(parsed[0]!)).toContain("race_track_corner");
  });

  it("is idempotent and a no-op on a document that has no such block", () => {
    const without = DOC.replace(block, "");
    expect(strip(without)).toBe(without);
    expect(strip(strip(DOC))).toBe(strip(DOC));
  });
});

describe("the invariant holds when the tables are in a different order", () => {
  // insertEarly prepends, edit turns echo — document order is not something any
  // single call site controls, so no regex may depend on it.
  const REORDERED = `<!doctype html><html><body>${IMPORTMAP}${AR_EDGES}${AR_AXES}${HELPER}${AR_SIZES}${GAME}${AR_ASSETS}</body></html>`;

  it.each(TABLES)("$name strips cleanly regardless of position", ({ block, strip }) => {
    expect(strip(REORDERED)).toBe(REORDERED.replace(block, ""));
  });
});
