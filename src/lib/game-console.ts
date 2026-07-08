// Captures console output + runtime errors from inside a sandboxed game
// preview and forwards them to the parent frame, so a broken game shows WHY
// instead of just a blank/frozen canvas. Pure string/logic module — no DOM,
// no React (SRP: ArtifactFrame owns the UI, this owns the capture script).

import type { GameConsoleMessage } from "@/types/game-console.types";

export const GAME_CONSOLE_SOURCE = "kidgemini-game-console" as const;

/** Marker so injectConsoleCapture is idempotent (never double-inject). */
const MARKER = "<!--kidgemini-console-capture-->";

/**
 * Source for the capture script, injected verbatim into the game's iframe.
 * Runs in the iframe's own global scope — must not assume any bundler/module
 * system, only `console`, `window`, `addEventListener`, `parent.postMessage`.
 */
export function buildConsoleCaptureScript(): string {
  return `
(function () {
  function fmt(a) {
    if (typeof a === "string") return a;
    if (a && typeof a === "object") {
      try { return JSON.stringify(a); } catch (e) { /* circular, fall through */ }
    }
    return String(a);
  }
  function post(level, text) {
    try {
      parent.postMessage({ source: "${GAME_CONSOLE_SOURCE}", message: { level: level, text: text } }, "*");
    } catch (e) { /* parent gone (frame closed mid-post) — nothing to do */ }
  }
  ["log", "warn", "error"].forEach(function (level) {
    var original = console[level] ? console[level].bind(console) : function () {};
    console[level] = function () {
      var args = Array.prototype.slice.call(arguments);
      post(level, args.map(fmt).join(" "));
      original.apply(console, args);
    };
  });
  window.onerror = function (message, source, lineno, colno) {
    post("error", fmt(message) + " (" + source + ":" + lineno + ":" + colno + ")");
  };
  addEventListener("unhandledrejection", function (event) {
    var reason = event.reason;
    var text = (reason && reason.message) ? reason.message : fmt(reason);
    post("error", "Unhandled promise rejection: " + text);
  });
})();
`.trim();
}

/** Inserts the capture script as early as possible so it wins the race
 *  against the game's own code (in <head>, else right after <html>, else
 *  at the very top). Idempotent via MARKER so re-injection is a no-op. */
export function injectConsoleCapture(html: string): string {
  if (html.includes(MARKER)) return html;
  const script = `${MARKER}<script>${buildConsoleCaptureScript()}</script>`;

  const headMatch = html.match(/<head[^>]*>/i);
  if (headMatch) {
    const idx = headMatch.index! + headMatch[0].length;
    return html.slice(0, idx) + script + html.slice(idx);
  }

  const htmlMatch = html.match(/<html[^>]*>/i);
  if (htmlMatch) {
    const idx = htmlMatch.index! + htmlMatch[0].length;
    return html.slice(0, idx) + script + html.slice(idx);
  }

  return script + html;
}

export type { GameConsoleMessage };
