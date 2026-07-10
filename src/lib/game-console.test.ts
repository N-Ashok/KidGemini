import { describe, it, expect } from "vitest";
import vm from "node:vm";
import { GAME_CONSOLE_SOURCE, buildConsoleCaptureScript, injectConsoleCapture } from "./game-console";

describe("injectConsoleCapture — placement", () => {
  it("inserts the capture script right after <head> so it runs before game code", () => {
    const html = "<!doctype html><html><head><title>Fox Run</title></head><body></body></html>";
    const out = injectConsoleCapture(html);
    const headIdx = out.indexOf("<head>");
    const scriptIdx = out.indexOf("<script>");
    const titleIdx = out.indexOf("<title>");
    expect(scriptIdx).toBeGreaterThan(headIdx);
    expect(scriptIdx).toBeLessThan(titleIdx);
  });

  it("falls back to inserting right after <html> when there is no <head>", () => {
    const html = "<!doctype html><html><body><script>doStuff()</script></body></html>";
    const out = injectConsoleCapture(html);
    const htmlTagEnd = out.indexOf("<html>") + "<html>".length;
    const injectedScriptIdx = out.indexOf("<script>");
    // Nothing but the idempotency marker comment sits between <html> and the
    // injected <script> — i.e. it's the very first thing in the document body.
    expect(out.slice(htmlTagEnd, injectedScriptIdx)).toBe("<!--kidgemini-console-capture-->");
    expect(out.indexOf(buildConsoleCaptureScript())).toBeLessThan(out.indexOf("doStuff()"));
  });

  it("is idempotent — injecting twice does not duplicate the capture script", () => {
    const html = "<!doctype html><html><head></head><body></body></html>";
    const once = injectConsoleCapture(html);
    const twice = injectConsoleCapture(once);
    expect(twice).toBe(once);
  });
});

/**
 * Runtime behavior of the injected script — evaluated in a real sandboxed
 * context (node:vm) standing in for the iframe's window, so this exercises
 * the actual capture logic rather than just string shape.
 */
describe("injectConsoleCapture — runtime behavior (sandboxed via node:vm)", () => {
  function runInSandbox() {
    const posted: any[] = [];
    const handlers: Record<string, Array<(e: unknown) => void>> = {};
    const sandbox: Record<string, unknown> = {
      console: { log: () => {}, warn: () => {}, error: () => {} },
      parent: { postMessage: (msg: unknown) => posted.push(msg) },
      window: undefined,
      addEventListener: (name: string, fn: (e: unknown) => void) => {
        (handlers[name] ??= []).push(fn);
      },
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(buildConsoleCaptureScript(), sandbox);
    const fire = (name: string, event: unknown) => handlers[name]?.forEach((fn) => fn(event));
    /** Parent handshake — flushes the in-iframe buffer (PRD §0 A2 race fix). */
    const ready = () => fire("message", { data: { source: "kidgemini-parent", type: "ready" } });
    return { sandbox, posted, fire, ready };
  }

  it("buffers everything until the parent posts ready, then flushes in order", () => {
    const { sandbox, posted, ready } = runInSandbox();
    (sandbox.console as any).error("boom");
    (sandbox.console as any).log("score 3");
    expect(posted).toHaveLength(0); // nothing leaks before the handshake
    ready();
    expect(posted.map((p) => p.message.text)).toEqual(["boom", "score 3"]);
  });

  it("posts directly (no buffering) after the ready handshake", () => {
    const { sandbox, posted, ready } = runInSandbox();
    ready();
    (sandbox.console as any).error("boom", 42);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      source: GAME_CONSOLE_SOURCE,
      message: { level: "error", text: "boom 42" },
    });
  });

  it("forwards console.warn and console.log at their own levels", () => {
    const { sandbox, posted, ready } = runInSandbox();
    ready();
    (sandbox.console as any).warn("careful");
    (sandbox.console as any).log("score is 3");
    expect(posted.map((p) => p.message)).toEqual([
      { level: "warn", text: "careful" },
      { level: "log", text: "score is 3" },
    ]);
  });

  it("captures runtime errors STRUCTURED — message, filename, line, col and stack (V.1)", () => {
    const { posted, fire, ready } = runInSandbox();
    ready();
    fire("error", {
      message: "Uncaught ReferenceError: fox is not defined",
      filename: "game.html",
      lineno: 12,
      colno: 4,
      error: { stack: "ReferenceError: fox is not defined\n  at gameLoop (game.html:12:4)" },
    });
    expect(posted).toHaveLength(1);
    expect(posted[0].message).toMatchObject({
      level: "error",
      kind: "error",
      filename: "game.html",
      line: 12,
      col: 4,
    });
    expect(posted[0].message.stack).toContain("at gameLoop");
    expect(posted[0].message.text).toContain("ReferenceError");
  });

  it("captures failed subresource loads as kind:resource with the URL (V.3)", () => {
    const { sandbox, posted, fire, ready } = runInSandbox();
    ready();
    fire("error", { target: { src: "https://cdn.example.com/lib.js", tagName: "SCRIPT" } });
    expect(posted).toHaveLength(1);
    expect(posted[0].message).toMatchObject({
      level: "error",
      kind: "resource",
      url: "https://cdn.example.com/lib.js",
    });
    expect(sandbox).toBeDefined();
  });

  it("captures unhandled promise rejections with their stack", () => {
    const { posted, fire, ready } = runInSandbox();
    ready();
    const err = new Error("network down");
    fire("unhandledrejection", { reason: err });
    expect(posted).toHaveLength(1);
    expect(posted[0].message.kind).toBe("rejection");
    expect(posted[0].message.text).toContain("network down");
    expect(posted[0].message.stack).toContain("network down");
  });
});
