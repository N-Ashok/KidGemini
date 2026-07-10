"use client";
// Renders model-generated HTML games with a Preview / Code toggle (Claude-artifact style).
// SECURITY: preview runs in a sandboxed iframe — sandbox="allow-scripts" only (no
// same-origin, no top-navigation, no forms). Presentational.
//
// Self-healing preview (PRD-SELF-HEALING-PREVIEW): a verify pass runs behind an
// opaque cover card BEFORE the kid's first look — the iframe must be rendered
// and painting for rAF to tick (§8.1), so the loading state and the correctness
// requirement are the same object. Errors no longer switch the kid to a console
// tab (that unmounted the running game AND showed a nine-year-old a stack
// trace); the console is a debug tool now, hidden unless localStorage
// "kidgemini:debug" = "1" (grown-ups only — see docs).

import { useEffect, useState } from "react";
import { downloadCode } from "./download";
import { PublishToArcade } from "./PublishToArcade";
import { GAME_CONSOLE_SOURCE } from "@/lib/game-console";
import { injectPreviewInstrumentation } from "@/lib/preview-verify";
import { usePreviewVerify } from "./usePreviewVerify";
import type { GameConsoleMessage } from "@/types/game-console.types";
import type { VerifyCheckId } from "@/types/preview-verify.types";

interface ArtifactFrameProps {
  html: string | null;
  /** True while the reply is still streaming — publish waits for the full game. */
  busy?: boolean;
  /** The kid's ask that produced this game — repair prompts carry it (§7). */
  originalRequest?: string;
  onClose: () => void;
}

type Tab = "preview" | "code" | "console";

/** Suggested arcade name from the game's own <title>, if it has one. */
function titleOf(html: string): string {
  const m = html.match(/<title>([^<]{2,40})<\/title>/i);
  return m?.[1]?.trim() ?? "";
}

/** §8.3 — the honest checklist, in probe order, kid-readable. */
const CHECK_LABELS: Record<VerifyCheckId, string> = {
  loop: "It runs",
  canvas: "The screen is set up",
  drawing: "The screen is drawing",
  start: "The Start button works",
};

export function ArtifactFrame({ html, busy, originalRequest, onClose }: ArtifactFrameProps) {
  const [tab, setTab] = useState<Tab>("preview");
  const [copied, setCopied] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [consoleMessages, setConsoleMessages] = useState<GameConsoleMessage[]>([]);
  // Console tab is debug-only now (PRD G1: a kid never sees a console tab).
  const [debug, setDebug] = useState(false);
  useEffect(() => {
    try {
      setDebug(window.localStorage.getItem("kidgemini:debug") === "1");
    } catch {
      /* storage unavailable — stay kid-safe */
    }
  }, []);

  const { view, iframeRef, onIframeLoad, reloadToken } = usePreviewVerify(html ?? "", originalRequest ?? "");
  const covered = view.phase !== "done";

  // Each new/updated game is a fresh iframe load — start its console clean.
  // (No auto-switch on error anymore: errors now feed the verify/repair loop.)
  useEffect(() => {
    setConsoleMessages([]);
    function handleMessage(event: MessageEvent) {
      if (event.data?.source !== GAME_CONSOLE_SOURCE) return;
      const message = event.data.message as GameConsoleMessage;
      setConsoleMessages((prev) => [...prev, message]);
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [html]);

  if (!html) return null;

  const errorCount = consoleMessages.filter((m) => m.level === "error").length;

  // Download/copy/publish all use the LIVE version — after a self-heal the
  // repaired game is the game, not the broken original.
  async function copy() {
    try {
      await navigator.clipboard.writeText(view.currentHtml);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  const tabBtn = (t: Tab) =>
    `rounded-full px-3 py-1 text-sm font-medium ${
      tab === t ? "bg-neutral-900 text-white" : "text-neutral-600 hover:bg-neutral-100"
    } disabled:opacity-40`;

  return (
    <aside className="flex h-full w-full flex-col bg-white">
      <header className="flex items-center justify-between gap-2 border-b border-neutral-200 px-4 py-2.5">
        <div className="flex items-center gap-2">
          {/* Mobile-only: the frame covers the whole screen there, so give an
              explicit way back to the conversation (✕ alone wasn't found). */}
          <button
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-sm font-medium text-neutral-600 hover:bg-neutral-100 md:hidden"
            aria-label="Back to chat"
          >
            ← Chat
          </button>
          <button onClick={() => setTab("preview")} className={tabBtn("preview")}>
            ▶ Preview
          </button>
          {/* Leaving Preview unmounts the iframe (tabs conditionally render) —
              mid-verify that would blind the probes, so hold the kid here for
              the ~2.5s testing window. */}
          <button onClick={() => setTab("code")} className={tabBtn("code")} disabled={covered}>
            {"</>"} Code
          </button>
          {debug && (
            <button onClick={() => setTab("console")} className={`relative ${tabBtn("console")}`} disabled={covered}>
              🛠 <span className="hidden sm:inline">Console</span>
              {errorCount > 0 && (
                <span className="ml-1 rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-bold text-white">
                  {errorCount}
                </span>
              )}
            </button>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {/* Publish lives HERE (not a bar under the game — that sat exactly on
              kids' on-screen controls). Compact pill, hidden while streaming. */}
          {!busy && (
            <button
              onClick={() => setPublishing(true)}
              className="rounded-full bg-orange-500 px-3 py-1.5 text-sm font-extrabold text-white shadow shadow-orange-500/30"
              aria-label="Put it in the Arcade"
            >
              🚀 <span className="hidden sm:inline">Arcade</span>
            </button>
          )}
          <button
            onClick={() => downloadCode(view.currentHtml, "html", "game.html")}
            className="rounded-lg px-2 py-1 text-sm text-neutral-600 hover:bg-neutral-100"
            aria-label="Download game"
          >
            ⬇<span className="hidden md:inline"> Download</span>
          </button>
          <button
            onClick={copy}
            className="rounded-lg px-2 py-1 text-sm text-neutral-600 hover:bg-neutral-100"
            aria-label="Copy HTML"
          >
            {copied ? "✓" : "⧉"}<span className="hidden md:inline">{copied ? " Copied" : " Copy"}</span>
          </button>
          <button
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-neutral-600 hover:bg-neutral-100"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
      </header>

      <p className="border-b border-neutral-100 px-4 py-1.5 text-xs text-neutral-400">
        Made by AI · runs safely in a sandbox
      </p>

      {/* §9.1 — repair exhausted: a question, never an apology + stack trace. */}
      {view.question && tab === "preview" && (
        <div className="border-b border-orange-100 bg-orange-50 px-4 py-2 text-sm text-orange-800">
          {view.question}
        </div>
      )}

      {tab === "preview" && (
        <div className="relative min-h-0 w-full flex-1">
          <iframe
            key={reloadToken} // reload after a probe-click clean → pristine title screen
            ref={iframeRef}
            title="AI-generated game"
            sandbox="allow-scripts"
            srcDoc={injectPreviewInstrumentation(view.currentHtml)}
            onLoad={onIframeLoad}
            className="h-full w-full border-0"
          />
          {/* §8.1 — the cover card. The iframe is RENDERED AND PAINTING under
              this opaque layer (display:none would stop rAF and make healthy
              games look dead); the kid sees the checklist, not the probes. */}
          {covered && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-white px-6">
              {view.phase === "repairing" && view.kidLine ? (
                <>
                  <span className="animate-bounce text-3xl" aria-hidden>🔧</span>
                  <p className="text-center text-base font-semibold text-neutral-800">{view.kidLine}</p>
                </>
              ) : (
                <>
                  <p className="text-base font-semibold text-neutral-800">Testing your game…</p>
                  <ul className="space-y-1 text-sm text-neutral-600">
                    {(Object.keys(CHECK_LABELS) as VerifyCheckId[]).map((id) => {
                      const done = view.checks.find((c) => c.check === id);
                      // Only show rows the probes have reached or will reach next —
                      // real results, not a fake progress bar (§8.3).
                      if (!done && !view.checks.length && id !== "loop") return null;
                      return (
                        <li key={id}>
                          {done ? (done.ok ? "✓" : "…") : "⟳"} {CHECK_LABELS[id]}
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </div>
          )}
        </div>
      )}
      {tab === "code" && (
        /* min-h-0 (not h-full): a flex child refuses to shrink below its content
           by default, so with h-full the code block overflowed past the panel
           and the overflow-auto scrollbar never appeared. */
        <pre className="min-h-0 flex-1 overflow-auto bg-neutral-900 p-4 text-[12px] leading-5 text-neutral-100">
          <code>{view.currentHtml}</code>
        </pre>
      )}
      {tab === "console" && debug && (
        <div className="min-h-0 flex-1 overflow-auto bg-neutral-950 p-3 font-mono text-[12px] leading-5">
          {consoleMessages.length === 0 ? (
            <p className="text-neutral-500">No console output yet — play the game to see logs and errors here.</p>
          ) : (
            consoleMessages.map((m, i) => (
              <div
                key={i}
                className={`whitespace-pre-wrap border-b border-neutral-800 py-1 ${
                  m.level === "error"
                    ? "text-red-400"
                    : m.level === "warn"
                      ? "text-amber-400"
                      : "text-neutral-300"
                }`}
              >
                <span className="mr-1 opacity-60">{m.level === "error" ? "✕" : m.level === "warn" ? "⚠" : "›"}</span>
                {m.text}
                {m.stack && <div className="pl-4 opacity-70">{m.stack}</div>}
              </div>
            ))
          )}
        </div>
      )}

      {publishing && (
        <PublishToArcade html={view.currentHtml} suggestedName={titleOf(view.currentHtml)} onClose={() => setPublishing(false)} />
      )}
    </aside>
  );
}
