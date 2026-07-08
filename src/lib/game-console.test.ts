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
    const posted: unknown[] = [];
    const sandbox: Record<string, unknown> = {
      console: { log: () => {}, warn: () => {}, error: () => {} },
      parent: { postMessage: (msg: unknown) => posted.push(msg) },
      window: undefined,
      addEventListener: () => {},
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(buildConsoleCaptureScript(), sandbox);
    return { sandbox, posted };
  }

  it("forwards console.error calls to the parent as a GameConsoleEvent", () => {
    const { sandbox, posted } = runInSandbox();
    (sandbox.console as any).error("boom", 42);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      source: GAME_CONSOLE_SOURCE,
      message: { level: "error", text: "boom 42" },
    });
  });

  it("forwards console.warn and console.log at their own levels", () => {
    const { sandbox, posted } = runInSandbox();
    (sandbox.console as any).warn("careful");
    (sandbox.console as any).log("score is 3");
    expect(posted).toEqual([
      { source: GAME_CONSOLE_SOURCE, message: { level: "warn", text: "careful" } },
      { source: GAME_CONSOLE_SOURCE, message: { level: "log", text: "score is 3" } },
    ]);
  });

  it("captures uncaught runtime errors via window.onerror", () => {
    const { sandbox, posted } = runInSandbox();
    (sandbox.window as any).onerror("Uncaught ReferenceError: fox is not defined", "game.html", 12, 4);
    expect(posted).toHaveLength(1);
    expect((posted[0] as any).message.level).toBe("error");
    expect((posted[0] as any).message.text).toContain("ReferenceError");
  });

  it("captures unhandled promise rejections", () => {
    const { sandbox, posted } = runInSandbox();
    const handlers: Record<string, (e: unknown) => void> = {};
    (sandbox.addEventListener as unknown) = (name: string, fn: (e: unknown) => void) => {
      handlers[name] = fn;
    };
    vm.runInContext(buildConsoleCaptureScript(), sandbox);
    handlers["unhandledrejection"]?.({ reason: new Error("network down") });
    expect(posted.some((m) => (m as any).message?.text?.includes("network down"))).toBe(true);
  });
});
