// Captures console output + runtime errors from inside a sandboxed game
// preview and forwards them to the parent frame, so a broken game shows WHY
// instead of just a blank/frozen canvas. Pure string/logic module — no DOM,
// no React (SRP: ArtifactFrame owns the UI, this owns the capture script).

import type { GameConsoleMessage } from "@/types/game-console.types";
import { GAME_CONSOLE_SOURCE, PARENT_READY_SOURCE, CONSOLE_CAPTURE_MARKER } from "./preview-messages";

export { GAME_CONSOLE_SOURCE };

/** Marker so injectConsoleCapture is idempotent (never double-inject). */
const MARKER = CONSOLE_CAPTURE_MARKER;

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
  // The parent's message listener mounts in a React effect, so a message fired
  // in the game's first ticks could race it and vanish. Buffer until the
  // parent posts {source:"${PARENT_READY_SOURCE}", type:"ready"}, then flush.
  var buffer = [];
  var ready = false;
  function send(message) {
    try {
      parent.postMessage({ source: "${GAME_CONSOLE_SOURCE}", message: message }, "*");
    } catch (e) { /* parent gone (frame closed mid-post) — nothing to do */ }
  }
  function post(message) {
    if (ready) send(message); else buffer.push(message);
  }
  addEventListener("message", function (event) {
    var d = event && event.data;
    if (!d || d.source !== "${PARENT_READY_SOURCE}" || d.type !== "ready") return;
    ready = true;
    for (var i = 0; i < buffer.length; i++) send(buffer[i]);
    buffer = [];
  });
  ["log", "warn", "error"].forEach(function (level) {
    var original = console[level] ? console[level].bind(console) : function () {};
    console[level] = function () {
      var args = Array.prototype.slice.call(arguments);
      post({ level: level, text: args.map(fmt).join(" ") });
      original.apply(console, args);
    };
  });
  // Capture-phase window listener sees BOTH uncaught throws and failed
  // subresource loads (script/img error events don't bubble). The structured
  // fields — especially the stack — are the repair input (PRD §5.1).
  addEventListener("error", function (e) {
    var t = e && e.target;
    // Classify by the EVENT, not by whether a URL happens to be readable.
    // Only a real ErrorEvent carries a string \`message\`; a failed subresource
    // is a plain Event whose target is the element. Media elements keep their
    // URL on currentSrc, a failed <source> child leaves nothing on the parent,
    // and src can legitimately be "" — so the old \`t.src || t.href\` gate
    // misrouted all of those into the script branch below, where message /
    // filename / lineno are undefined and the kid's report read literally
    // "undefined (undefined:undefined:undefined)". It also denied
    // classifyVerify the kind:"resource" it needs to say resource_404, so
    // auto-repair went chasing a load_error with nothing to repair from.
    // (BUG-FIX-LOG 2026-08-08.)
    var isScriptError = !!(e && typeof e.message === "string");
    if (!isScriptError && t && t !== window) {
      var url = String(t.currentSrc || t.src || t.href || "");
      var tag = String(t.tagName || "").toLowerCase();
      post({
        level: "error",
        kind: "resource",
        text:
          "Failed to load" +
          (tag ? " <" + tag + ">" : " a resource") +
          (url ? ": " + url : " (the element carried no source URL)"),
        url: url,
      });
      return;
    }
    // An error we cannot describe is still worth reporting — but it must say
    // so in words, never as a bare "undefined".
    var msg = isScriptError && e.message ? e.message : "Unknown error (the browser reported no details)";
    var file = (e && e.filename) || "";
    var ln = (e && e.lineno) || 0;
    var cl = (e && e.colno) || 0;
    post({
      level: "error",
      kind: "error",
      text: msg + (file ? " (" + file + ":" + ln + ":" + cl + ")" : ""),
      filename: file,
      line: ln,
      col: cl,
      stack: e && e.error && e.error.stack ? String(e.error.stack) : "",
    });
  }, true);
  addEventListener("unhandledrejection", function (event) {
    var reason = event && event.reason;
    post({
      level: "error",
      kind: "rejection",
      text: "Unhandled promise rejection: " + ((reason && reason.message) || fmt(reason)),
      stack: reason && reason.stack ? String(reason.stack) : "",
    });
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
