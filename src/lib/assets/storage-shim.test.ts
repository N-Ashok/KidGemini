// Games that save a high score must not die in the preview (2026-08-16).
//
// FOUND BY: the golden-prompt run — the first thing it has ever caught on its
// own. `plain-2d.html` ("Star Catcher") read `localStorage.getItem` while
// building its state object. The Ari preview is an iframe with
// sandbox="allow-scripts" and NO allow-same-origin (ArtifactFrame.tsx), which
// is an OPAQUE ORIGIN: touching localStorage there throws
//
//   Failed to read the 'localStorage' property from 'Window': The document is
//   sandboxed and lacks the 'allow-same-origin' flag.
//
// PROVEN IN THE REAL CONTAINER, not reasoned about: loaded in that exact
// iframe, the title screen paints and START VOYAGE does nothing at all — the
// throw happens at init, so no handler is ever registered. The child sees a
// finished-looking game with a dead button. With the shim installed first, the
// same file plays. Screenshots both ways.
//
// WHY A SHIM AND NOT A PROMPT RULE: a prompt rule reaches new builds only, and
// "save the high score" is one of the most common things a child asks for.
// Every stored game with this fault is broken until something retrofits it,
// and the runtime floor is the only path that reaches games that already
// exist. The prompt rule is worth having too, but it cannot be the fix.
//
// The scores do not persist — they cannot, in an opaque origin. A game that
// plays and forgets is enormously better than one that will not start.
import { describe, it, expect } from "vitest";
import { ensureStorageShim, STORAGE_SHIM_MARKER } from "./storage-shim";
import { ensureAssetRuntime } from "./ensure-runtime";

const gameUsingStorage = (body: string) =>
  `<!DOCTYPE html><html><head><title>Star Catcher</title></head><body>${body}</body></html>`;

describe("when the shim is added", () => {
  it("adds it to a 2D game that reads localStorage", () => {
    const html = gameUsingStorage(`<script>const hi = localStorage.getItem('high') || 0;</script>`);
    expect(ensureStorageShim(html)).toContain(STORAGE_SHIM_MARKER);
  });

  it("adds it for sessionStorage too — same opaque-origin throw", () => {
    const html = gameUsingStorage(`<script>sessionStorage.setItem('a', '1');</script>`);
    expect(ensureStorageShim(html)).toContain(STORAGE_SHIM_MARKER);
  });

  it("adds it for window.localStorage and optional-chained forms", () => {
    for (const use of ["window.localStorage.getItem('k')", "window?.localStorage?.setItem('k','v')"]) {
      expect(ensureStorageShim(gameUsingStorage(`<script>${use}</script>`))).toContain(STORAGE_SHIM_MARKER);
    }
  });

  it("does NOT add it to a game that never touches storage — no cost for nothing", () => {
    const html = gameUsingStorage(`<script>const s = 0;</script>`);
    expect(ensureStorageShim(html)).toBe(html);
  });

  it("is idempotent — a game floored twice gets one shim", () => {
    const once = ensureStorageShim(gameUsingStorage(`<script>localStorage.getItem('h')</script>`));
    expect(ensureStorageShim(once)).toBe(once);
    expect(once.split(STORAGE_SHIM_MARKER).length - 1).toBe(1);
  });
});

describe("where the shim lands — it must run BEFORE the game", () => {
  it("comes before the game's first script", () => {
    const html = gameUsingStorage(`<script id="game">localStorage.getItem('h')</script>`);
    const out = ensureStorageShim(html);
    expect(out.indexOf(STORAGE_SHIM_MARKER)).toBeLessThan(out.indexOf('id="game"'));
  });

  it("comes before a module script too (module scripts are deferred, but head order still decides)", () => {
    const html = gameUsingStorage(`<script type="module" id="game">localStorage.getItem('h')</script>`);
    const out = ensureStorageShim(html);
    expect(out.indexOf(STORAGE_SHIM_MARKER)).toBeLessThan(out.indexOf('id="game"'));
  });

  it("handles html with no <head> at all without losing the game", () => {
    const html = `<html><body><script>localStorage.getItem('h')</script></body></html>`;
    const out = ensureStorageShim(html);
    expect(out).toContain(STORAGE_SHIM_MARKER);
    expect(out).toContain("localStorage.getItem('h')");
    expect(out.indexOf(STORAGE_SHIM_MARKER)).toBeLessThan(out.indexOf("localStorage.getItem"));
  });

  it("handles a bare fragment with no html/body wrapper", () => {
    const html = `<canvas></canvas><script>localStorage.setItem('a','b')</script>`;
    const out = ensureStorageShim(html);
    expect(out).toContain(STORAGE_SHIM_MARKER);
    expect(out).toContain("<canvas></canvas>");
  });
});

describe("degenerate input must never throw or eat the game", () => {
  for (const [label, input] of [
    ["empty", ""],
    ["whitespace", "   "],
    ["no scripts", "<html><body><p>hi</p></body></html>"],
    ["truncated", "<!DOCTYPE html><html><body><script>localStorage.get"],
  ] as const) {
    it(label, () => {
      expect(() => ensureStorageShim(input)).not.toThrow();
    });
  }

  it("a game that merely MENTIONS localStorage in a comment still gets it — cheap and harmless", () => {
    // Deliberately fail SAFE here rather than clever: over-including a 400-byte
    // shim costs nothing; missing one leaves a child with a dead button.
    const html = gameUsingStorage(`<script>// no localStorage in this game\nconst a = 1;</script>`);
    expect(ensureStorageShim(html)).toContain(STORAGE_SHIM_MARKER);
  });
});

describe("the shim's own behaviour", () => {
  // Run the shim source in a fake window where localStorage throws, exactly as
  // the sandboxed iframe does, and check the stand-in behaves like the real
  // thing. (The full browser proof lives in the scratchpad harness; this pins
  // the semantics so a future edit cannot quietly break getItem/setItem.)
  function runShim() {
    const win: Record<string, unknown> = {};
    Object.defineProperty(win, "localStorage", {
      get() { throw new Error("Access is denied for this document."); },
      configurable: true,
    });
    Object.defineProperty(win, "sessionStorage", {
      get() { throw new Error("Access is denied for this document."); },
      configurable: true,
    });
    const src = ensureStorageShim(`<html><head></head><body><script>localStorage</script></body></html>`)
      .match(/<script>([\s\S]*?)<\/script>/)![1]!;
    new Function("window", src)(win);
    return win as { localStorage: Storage; sessionStorage: Storage };
  }

  it("replaces a throwing localStorage with a working stand-in", () => {
    const win = runShim();
    expect(() => win.localStorage.getItem("x")).not.toThrow();
  });

  it("getItem returns null for an unknown key, like the real API", () => {
    expect(runShim().localStorage.getItem("nope")).toBeNull();
  });

  it("round-trips a value as a string, like the real API", () => {
    const win = runShim();
    win.localStorage.setItem("high", 42 as unknown as string);
    expect(win.localStorage.getItem("high")).toBe("42");
  });

  it("supports removeItem, clear and length", () => {
    const win = runShim();
    win.localStorage.setItem("a", "1");
    win.localStorage.setItem("b", "2");
    expect(win.localStorage.length).toBe(2);
    win.localStorage.removeItem("a");
    expect(win.localStorage.getItem("a")).toBeNull();
    win.localStorage.clear();
    expect(win.localStorage.length).toBe(0);
  });

  it("shims sessionStorage as a SEPARATE store", () => {
    const win = runShim();
    win.localStorage.setItem("k", "local");
    expect(win.sessionStorage.getItem("k")).toBeNull();
  });
});

describe("integration with the runtime floor", () => {
  it("a plain 2D game — which the floor otherwise leaves untouched — still gets the shim", () => {
    // The regression that matters: ensureAssetRuntime returns early for any
    // game that uses no 3D assets, and Star Catcher is exactly that game.
    const html = gameUsingStorage(`<canvas></canvas><script>const hi = localStorage.getItem('high');</script>`);
    const out = ensureAssetRuntime(html);
    expect(out).toContain(STORAGE_SHIM_MARKER);
    expect(out).toContain("<canvas></canvas>");
  });

  it("a plain 2D game with NO storage use is still returned unchanged", () => {
    const html = gameUsingStorage(`<canvas></canvas><script>const a = 1;</script>`);
    expect(ensureAssetRuntime(html)).toBe(html);
  });

  it("a 3D game that saves a high score gets both the shim and the asset runtime", () => {
    const html = gameUsingStorage(
      `<script type="module">import { Scene } from "three";\nconst best = localStorage.getItem('best');\nconst c = await loadModel("car");</script>`,
    );
    const out = ensureAssetRuntime(html);
    expect(out).toContain(STORAGE_SHIM_MARKER);
    expect(out).toContain("window.loadModel =");
    expect(out).toContain('type="importmap"');
    // The import map must still be the first thing the browser meets among
    // module machinery — the shim must not have displaced it (BUG-FIX-LOG
    // 2026-08-09, the production outage).
    expect(out.indexOf('type="importmap"')).toBeLessThan(out.indexOf('type="module"'));
  });
});
