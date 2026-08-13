// BUG-FIX-LOG 2026-08-13: a real generated game (River Nomad 3D) crashed on
// load with `pageerror: Invalid or unexpected token` — a genuine JS syntax
// error, confirmed by loading the stored artifact in a real browser
// (scripts/verify-game-html.mjs). Nothing in the pipeline caught this before
// it reached the kid; the self-heal loop could patch it AFTER the fact, but
// only once the kid had already seen a broken game. This is the deterministic,
// pre-delivery half: parse-check with acorn (no execution, no browser) so a
// malformed document never ships in the first place.
import { describe, it, expect } from "vitest";
import { findJsSyntaxError } from "./js-syntax-lint";

const wrap = (script: string) => `<!doctype html><html><body>\n<script type="module">\n${script}\n</script>\n</body></html>`;

describe("findJsSyntaxError", () => {
  it("returns null for valid module syntax, including a bare 'three' import", () => {
    const html = wrap(`import { Scene } from "three";\nconst s = new Scene();\nfunction tick() { requestAnimationFrame(tick); }\ntick();`);
    expect(findJsSyntaxError(html)).toBeNull();
  });

  it("catches an actual malformed-token error (the exact class that broke River Nomad)", () => {
    // A stray, unmatched closing brace — reliably "Unexpected token" in acorn.
    const html = wrap(`function kick() { const x = 1; }}\nkick();`);
    const err = findJsSyntaxError(html);
    expect(err).not.toBeNull();
    expect(err!.message.toLowerCase()).toContain("unexpected token");
  });

  it("reports a line number when the parser gives one", () => {
    const html = wrap(`const a = 1;\nconst b = 2;\nfunction f( { }`);
    const err = findJsSyntaxError(html);
    expect(err).not.toBeNull();
    expect(typeof err!.line).toBe("number");
  });

  it("skips a <script src=...> tag entirely — nothing to parse, and it's already caught elsewhere (external-script lint)", () => {
    const html = `<!doctype html><html><body><script src="https://cdn.example.com/lib.js"></script></body></html>`;
    expect(findJsSyntaxError(html)).toBeNull();
  });

  it("checks every inline script block, not just the first", () => {
    const html =
      `<!doctype html><html><body>` +
      `<script>const ok = 1;</script>` +
      `<script type="module">function bad( {</script>` +
      `</body></html>`;
    expect(findJsSyntaxError(html)).not.toBeNull();
  });

  it("is a no-op on a document with no script content at all", () => {
    expect(findJsSyntaxError("<!doctype html><html><body>Hello</body></html>")).toBeNull();
  });

  // Caught in my own testing against the real broken game before this shipped:
  // every 3D game carries a leading `<script type="importmap">` (JSON, not
  // JS) — an earlier version of this regex matched it regardless of `type`
  // and flagged VALID JSON as a JS syntax error, which would have blocked
  // every 3D game in the pipeline. type="importmap" is exactly the fixture.
  it("never parses a non-JS script block (importmap, JSON) as JavaScript", () => {
    const html =
      `<!doctype html><html><body>` +
      `<script type="importmap">{"imports":{"three":"https://assets.ariantra.com/three.js"}}</script>` +
      `<script type="module">import { Scene } from "three"; new Scene();</script>` +
      `</body></html>`;
    expect(findJsSyntaxError(html)).toBeNull();
  });

  it("still catches a real syntax error alongside a valid importmap block", () => {
    const html =
      `<!doctype html><html><body>` +
      `<script type="importmap">{"imports":{"three":"https://assets.ariantra.com/three.js"}}</script>` +
      `<script type="module">function bad( {</script>` +
      `</body></html>`;
    expect(findJsSyntaxError(html)).not.toBeNull();
  });
});
