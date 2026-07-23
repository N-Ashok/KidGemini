// Preview WYSIWYG runtime injection (PRD-PREVIEW-WYSIWYG §7 step 3). Inlines the
// platform's preview-sdk.js (real sdk.js + publish overlays + local mock) into
// the sandboxed preview srcDoc so the preview shows the exact published overlays
// with NO backend and NO network. This REPLACES the old multiplayer-only
// injectPreviewSdkStub for ALL games (leaderboard/menu/etc appear everywhere =
// what-you-see-is-what-you-publish).

import { describe, it, expect } from "vitest";
import { injectPreviewRuntime, PREVIEW_RUNTIME_MARKER } from "./preview-runtime";
import { PREVIEW_SDK_BUNDLE } from "@/generated/preview-sdk-bundle";

const DOC = "<!doctype html><html><head><title>Game</title></head><body>GAME BODY<script>startGame()</script></body></html>";

describe("injectPreviewRuntime", () => {
  it("R.1 injects the runtime for EVERY game (not just SDK-using ones) — WYSIWYG for all", () => {
    const plain = "<!doctype html><html><head></head><body>a simple maze, no SDK</body></html>";
    const out = injectPreviewRuntime(plain, { theme: "default" });
    expect(out).toContain(PREVIEW_RUNTIME_MARKER);
    expect(out).toContain("window.ARIANTRA_PREVIEW");
  });

  it("R.2 sets the preview theme global BEFORE the runtime bundle runs", () => {
    const out = injectPreviewRuntime(DOC, { theme: "bible" });
    const themeIdx = out.indexOf('"theme":"bible"');
    const bundleIdx = out.indexOf(PREVIEW_SDK_BUNDLE.slice(0, 40));
    expect(themeIdx).toBeGreaterThan(-1);
    expect(bundleIdx).toBeGreaterThan(-1);
    expect(themeIdx).toBeLessThan(bundleIdx); // globals first, then the runtime reads them
  });

  it("R.3 an unknown theme falls back to 'default' (fail safe)", () => {
    const out = injectPreviewRuntime(DOC, { theme: "hacker" as never });
    expect(out).toContain('"theme":"default"');
    expect(out).not.toContain('"theme":"hacker"');
  });

  it("R.4 injects right after <head> so the runtime loads before game code", () => {
    const out = injectPreviewRuntime(DOC, { theme: "default" });
    const headEnd = out.indexOf("<head>") + "<head>".length;
    const marker = out.indexOf(PREVIEW_RUNTIME_MARKER);
    const body = out.indexOf("<body>");
    expect(marker).toBe(headEnd); // immediately after <head>
    expect(marker).toBeLessThan(body); // before the game body/script
  });

  it("R.4b declares UTF-8 FIRST (before the runtime) so emoji don't corrupt past the charset-sniff window", () => {
    const out = injectPreviewRuntime(DOC, { theme: "default" });
    const charset = out.indexOf('<meta charset="utf-8">');
    const bundle = out.indexOf(PREVIEW_SDK_BUNDLE.slice(0, 40));
    expect(charset).toBeGreaterThan(-1);
    expect(charset).toBeLessThan(bundle); // charset comes before the ~44KB runtime
    // …and within the first bytes of the injected block (the browser's sniff window).
    expect(charset - out.indexOf(PREVIEW_RUNTIME_MARKER)).toBeLessThan(80);
  });

  it("R.5 the inlined runtime script is never terminated early by a nested </script>", () => {
    // The overlays carry HTML strings with </script>; esbuild already escapes
    // those to <\/script> in the bundle (injectPreviewRuntime's escape is a
    // belt-and-braces safety net), so the inlined bundle carries no un-escaped
    // closing tag.
    expect(PREVIEW_SDK_BUNDLE).not.toContain("</script>");
    expect(PREVIEW_SDK_BUNDLE).toContain("<\\/script"); // pre-escaped form is present

    const out = injectPreviewRuntime(DOC, { theme: "default" });
    const injected = out.slice(out.indexOf(PREVIEW_RUNTIME_MARKER), out.indexOf("<body>"));
    // Exactly TWO real closing tags in the injected block: the globals script and
    // the runtime script. Any nested </script> would push this above 2 and break
    // the preview.
    expect((injected.match(/<\/script>/g) ?? []).length).toBe(2);
  });

  it("R.6 is idempotent — a second pass never double-injects", () => {
    const once = injectPreviewRuntime(DOC, { theme: "default" });
    const twice = injectPreviewRuntime(once, { theme: "default" });
    expect(twice).toBe(once);
  });

  it("R.7 preserves the original game markup", () => {
    const out = injectPreviewRuntime(DOC, { theme: "default" });
    expect(out).toContain("GAME BODY");
    expect(out).toContain("startGame()");
    expect(out).toContain("<title>Game</title>");
  });

  it("R.8 falls back to injecting after <html>, then prepending, when there is no <head>", () => {
    expect(injectPreviewRuntime("<html><body>x</body></html>", { theme: "default" })).toContain(PREVIEW_RUNTIME_MARKER);
    const noHtml = injectPreviewRuntime("<div>bare</div>", { theme: "default" });
    expect(noHtml.indexOf(PREVIEW_RUNTIME_MARKER)).toBe(0); // prepended
    expect(noHtml).toContain("<div>bare</div>");
  });
});
