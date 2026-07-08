"use client";
// Renders model-generated HTML games with a Preview / Code toggle (Claude-artifact style).
// SECURITY: preview runs in a sandboxed iframe — sandbox="allow-scripts" only (no
// same-origin, no top-navigation, no forms). Presentational.

import { useEffect, useRef, useState } from "react";
import { downloadCode } from "./download";
import { PublishToArcade } from "./PublishToArcade";
import { GAME_CONSOLE_SOURCE, injectConsoleCapture } from "@/lib/game-console";
import type { GameConsoleMessage } from "@/types/game-console.types";

interface ArtifactFrameProps {
  html: string | null;
  /** True while the reply is still streaming — publish waits for the full game. */
  busy?: boolean;
  onClose: () => void;
}

type Tab = "preview" | "code" | "console";

/** Suggested arcade name from the game's own <title>, if it has one. */
function titleOf(html: string): string {
  const m = html.match(/<title>([^<]{2,40})<\/title>/i);
  return m?.[1]?.trim() ?? "";
}

export function ArtifactFrame({ html, busy, onClose }: ArtifactFrameProps) {
  const [tab, setTab] = useState<Tab>("preview");
  const [copied, setCopied] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [consoleMessages, setConsoleMessages] = useState<GameConsoleMessage[]>([]);

  // Each new/updated game is a fresh iframe load — start its console clean,
  // and jump the kid straight to the Console tab the moment something breaks
  // (a blank frozen canvas is a dead end otherwise; see CLAUDE.md UX bar).
  useEffect(() => {
    setConsoleMessages([]);
    function handleMessage(event: MessageEvent) {
      if (event.data?.source !== GAME_CONSOLE_SOURCE) return;
      const message = event.data.message as GameConsoleMessage;
      setConsoleMessages((prev) => [...prev, message]);
      if (message.level === "error") setTab((t) => (t === "preview" ? "console" : t));
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [html]);

  if (!html) return null;

  const errorCount = consoleMessages.filter((m) => m.level === "error").length;

  async function copy() {
    try {
      await navigator.clipboard.writeText(html ?? "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  const tabBtn = (t: Tab, label: string) =>
    `rounded-full px-3 py-1 text-sm font-medium ${
      tab === t ? "bg-neutral-900 text-white" : "text-neutral-600 hover:bg-neutral-100"
    }`;

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
          <button onClick={() => setTab("preview")} className={tabBtn("preview", "Preview")}>
            ▶ Preview
          </button>
          <button onClick={() => setTab("code")} className={tabBtn("code", "Code")}>
            {"</>"} Code
          </button>
          <button onClick={() => setTab("console")} className={`relative ${tabBtn("console", "Console")}`}>
            🛠 <span className="hidden sm:inline">Console</span>
            {errorCount > 0 && (
              <span className="ml-1 rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-bold text-white">
                {errorCount}
              </span>
            )}
          </button>
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
            onClick={() => downloadCode(html ?? "", "html", "game.html")}
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

      {tab === "preview" && (
        <iframe
          title="AI-generated game"
          sandbox="allow-scripts"
          srcDoc={injectConsoleCapture(html)}
          className="min-h-0 w-full flex-1 border-0"
        />
      )}
      {tab === "code" && (
        /* min-h-0 (not h-full): a flex child refuses to shrink below its content
           by default, so with h-full the code block overflowed past the panel
           and the overflow-auto scrollbar never appeared. */
        <pre className="min-h-0 flex-1 overflow-auto bg-neutral-900 p-4 text-[12px] leading-5 text-neutral-100">
          <code>{html}</code>
        </pre>
      )}
      {tab === "console" && (
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
              </div>
            ))
          )}
        </div>
      )}

      {publishing && (
        <PublishToArcade html={html} suggestedName={titleOf(html)} onClose={() => setPublishing(false)} />
      )}
    </aside>
  );
}
