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

import { useEffect, useMemo, useRef, useState } from "react";
import { downloadCode } from "./download";
import { PublishToArcade } from "./PublishToArcade";
import { GAME_CONSOLE_SOURCE, injectConsoleCapture } from "@/lib/game-console";
import { DEVICE_PRESETS, deviceById, fitScale } from "@/lib/device-preview";
import { injectPreviewInstrumentation } from "@/lib/preview-verify";
import { keyToPanelAction, UPDATING_LINE } from "@/lib/preview-pane";
import { usePreviewVerify } from "./usePreviewVerify";
import type { GameConsoleMessage } from "@/types/game-console.types";
import type { PreviewDeviceId } from "@/types/device-preview.types";
import type { VerifyCheckId } from "@/types/preview-verify.types";

interface ArtifactFrameProps {
  html: string | null;
  /** True while the reply is still streaming — publish waits for the full game. */
  busy?: boolean;
  /** The kid's ask that produced this game — repair prompts carry it (§7). */
  originalRequest?: string;
  onClose: () => void;
  /** Desktop full-screen toggle (PRD-PREVIEW-PANE) — owned by the container,
      which restyles the panel wrapper; this component only shows the button. */
  expanded?: boolean;
  onToggleExpand?: () => void;
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

export function ArtifactFrame({ html, busy, originalRequest, onClose, expanded, onToggleExpand }: ArtifactFrameProps) {
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

  // Device preview: simulate a laptop/tablet/phone viewport inside the panel.
  // The device box keeps the preset's real CSS-pixel size and is scaled DOWN
  // (never up) to fit — so the game truly lays out at that viewport.
  const [device, setDevice] = useState<PreviewDeviceId>("fit");
  const previewBoxRef = useRef<HTMLDivElement>(null);
  const [panelSize, setPanelSize] = useState({ w: 0, h: 0 });
  useEffect(() => setDevice("fit"), [html]); // new game → verify at panel size

  // Esc leaves full screen (games often use Esc for pause — but the collapsed
  // panel keeps the game running, so worst case is a harmless un-expand).
  useEffect(() => {
    if (!onToggleExpand) return;
    function onKey(e: KeyboardEvent) {
      if (keyToPanelAction(e.key, expanded ?? false) === "collapse") onToggleExpand!();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded, onToggleExpand]);

  const { state, iframeRef, onIframeLoad, docKey } = usePreviewVerify(html ?? "", originalRequest ?? "");
  // Pinned per docKey (generation + round): probesEnabled flips false on every
  // finish, and letting srcDoc change without a docKey bump would reload
  // (flash) a game we decided NOT to reload. A new docKey = new document;
  // anything else stays put.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const srcDoc = useMemo(
    () =>
      state.probesEnabled
        ? injectPreviewInstrumentation(state.currentHtml)
        : injectConsoleCapture(state.currentHtml),
    [docKey],
  );
  const covered = state.phase !== "done";

  // Track the panel's size while a device frame is shown (scale-to-fit).
  useEffect(() => {
    const el = previewBoxRef.current;
    if (!el || device === "fit") return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setPanelSize({ w: entry.contentRect.width, h: entry.contentRect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [device, tab]);

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
      await navigator.clipboard.writeText(state.currentHtml);
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
            onClick={() => downloadCode(state.currentHtml, "html", "game.html")}
            className="rounded-lg px-2 py-1 text-sm text-neutral-600 hover:bg-neutral-100"
            aria-label="Download game"
            title="Download game"
          >
            {/* Text labels only in full screen — the 440px panel header can't
                fit them plus the expand toggle (✕ fell off the edge). */}
            ⬇<span className={expanded ? "hidden md:inline" : "hidden"}> Download</span>
          </button>
          <button
            onClick={copy}
            className="rounded-lg px-2 py-1 text-sm text-neutral-600 hover:bg-neutral-100"
            aria-label="Copy HTML"
            title="Copy HTML"
          >
            {copied ? "✓" : "⧉"}<span className={expanded ? "hidden md:inline" : "hidden"}>{copied ? " Copied" : " Copy"}</span>
          </button>
          {/* Full-screen toggle — md+ only (mobile is already full screen).
              Disabled while the verify cover is up, same reason as the device
              switcher: the probes must measure the game at a stable size. */}
          {onToggleExpand && (
            <button
              onClick={onToggleExpand}
              disabled={covered}
              className="hidden rounded-lg px-2 py-1 text-neutral-600 hover:bg-neutral-100 disabled:opacity-40 md:block"
              aria-label={expanded ? "Exit full screen" : "Full screen"}
              aria-pressed={expanded}
              title={expanded ? "Exit full screen (Esc)" : "Full screen"}
            >
              {expanded ? "⤡" : "⤢"}
            </button>
          )}
          <button
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-neutral-600 hover:bg-neutral-100"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
      </header>

      <div className="flex items-center justify-between gap-2 border-b border-neutral-100 px-4 py-1.5">
        <p className="hidden truncate text-xs text-neutral-400 sm:block">
          Made by AI · runs safely in a sandbox
        </p>
        {/* Device switcher: "how does it look on a phone?" — resizes the SAME
            iframe (no reload); disabled while the verify cover is up so the
            probes always measure the game at panel size. */}
        {tab === "preview" && (
          <div className="flex items-center gap-1" role="group" aria-label="Preview device size">
            {DEVICE_PRESETS.map((d) => (
              <button
                key={d.id}
                onClick={() => setDevice(d.id)}
                disabled={covered}
                title={d.hint}
                aria-pressed={device === d.id}
                className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                  device === d.id ? "bg-neutral-900 text-white" : "text-neutral-500 hover:bg-neutral-100"
                } disabled:opacity-40`}
              >
                {d.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* PRD-PREVIEW-PANE §2 — an update is streaming in the chat: the game on
          screen is the PREVIOUS version, still fully playable. Say so, so it
          reads as deliberate rather than stale. */}
      {busy && tab === "preview" && (
        <div className="border-b border-sky-100 bg-sky-50 px-4 py-1.5 text-sm text-sky-800">
          <span className="mr-1 inline-block animate-bounce" aria-hidden>🛠️</span>
          {UPDATING_LINE}
        </div>
      )}

      {/* §9.1 — repair exhausted: a question, never an apology + stack trace. */}
      {state.question && tab === "preview" && (
        <div className="border-b border-orange-100 bg-orange-50 px-4 py-2 text-sm text-orange-800">
          {state.question}
        </div>
      )}

      {tab === "preview" && (
        <div
          ref={previewBoxRef}
          className={`relative flex min-h-0 w-full flex-1 items-center justify-center overflow-hidden ${
            device === "fit" ? "" : "bg-neutral-100"
          }`}
        >
          {(() => {
            const preset = deviceById(device);
            const framed = preset.width !== null && preset.height !== null;
            // 24px breathing room around the device frame.
            const scale = framed
              ? fitScale(panelSize.w - 24, panelSize.h - 24, preset.width!, preset.height!)
              : 1;
            return (
              /* One stable wrapper around ONE stable iframe — switching device
                 restyles, never remounts (a remount would reload the game). */
              <div
                className={
                  framed
                    ? "shrink-0 overflow-hidden rounded-kid border border-neutral-200 bg-white shadow-md"
                    : "h-full w-full"
                }
                style={
                  framed
                    ? { width: preset.width!, height: preset.height!, transform: `scale(${scale})` }
                    : undefined
                }
              >
                <iframe
                  key={docKey} // bumps per game generation AND per verify round (incl. the pristine reload after a probe-click clean)
                  ref={iframeRef}
                  title="AI-generated game"
                  sandbox="allow-scripts"
                  srcDoc={srcDoc}
                  onLoad={onIframeLoad}
                  className="h-full w-full border-0"
                />
              </div>
            );
          })()}
          {/* §8.1 — the cover card. The iframe is RENDERED AND PAINTING under
              this opaque layer (display:none would stop rAF and make healthy
              games look dead); the kid sees the checklist, not the probes. */}
          {covered && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-white px-6">
              {state.phase === "repairing" && state.kidLine ? (
                <>
                  <span className="animate-bounce text-3xl" aria-hidden>🔧</span>
                  <p className="text-center text-base font-semibold text-neutral-800">{state.kidLine}</p>
                </>
              ) : (
                <>
                  <p className="text-base font-semibold text-neutral-800">Testing your game…</p>
                  <ul className="space-y-1 text-sm text-neutral-600">
                    {(Object.keys(CHECK_LABELS) as VerifyCheckId[]).map((id) => {
                      const done = state.checks.find((c) => c.check === id);
                      // Only show rows the probes have reached or will reach next —
                      // real results, not a fake progress bar (§8.3).
                      if (!done && !state.checks.length && id !== "loop") return null;
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
          <code>{state.currentHtml}</code>
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
        <PublishToArcade html={state.currentHtml} suggestedName={titleOf(state.currentHtml)} onClose={() => setPublishing(false)} />
      )}
    </aside>
  );
}
