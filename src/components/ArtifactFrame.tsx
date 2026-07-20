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
import { PublishToArcade } from "./PublishToArcade";
import { InviteToTest } from "./InviteToTest";
import { MULTIPLAYER_MARKER } from "@/lib/multiplayer-gate";
import { GAME_CONSOLE_SOURCE, injectConsoleCapture } from "@/lib/game-console";
import { DEVICE_PRESETS, deviceById, fitScale, orientedSize } from "@/lib/device-preview";
import { injectPreviewInstrumentation } from "@/lib/preview-verify";
import { injectPreviewSdkStub } from "@/lib/preview-sdk-stub";
import { keyToPanelAction, UPDATING_LINE } from "@/lib/preview-pane";
import { buildErrorReport, hasExtremeError } from "@/lib/error-report";
import { usePreviewVerify } from "./usePreviewVerify";
import { IdeaMicTab } from "./IdeaMicTab";
import { IdeaBag, type BagIdea } from "./IdeaBag";
import type { GameConsoleMessage } from "@/types/game-console.types";
import type { PreviewDeviceId, PreviewOrientation } from "@/types/device-preview.types";
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
  /** Idea Button (docs/PRD-IDEA-BUTTON.md) — all owned by the container; the
      frame only hosts the overlay surfaces. Absent props = feature hidden. */
  ideas?: BagIdea[];
  onCaptureIdea?: (text: string) => void;
  onDiscardIdea?: (id: string) => void;
  onEditIdea?: (id: string, text: string) => void;
  onMakeBetter?: () => void;
  /** First-run coach + one-time re-nudge (policy in the container; the tab
      renders them, so covered/unsupported states are enforced structurally). */
  coach?: boolean;
  onCoachDone?: () => void;
  nudgeMic?: boolean;
  onNudgeShown?: () => void;
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

export function ArtifactFrame({
  html,
  busy,
  originalRequest,
  onClose,
  expanded,
  onToggleExpand,
  ideas,
  onCaptureIdea,
  onDiscardIdea,
  onEditIdea,
  onMakeBetter,
  coach,
  onCoachDone,
  nudgeMic,
  onNudgeShown,
}: ArtifactFrameProps) {
  const [tab, setTab] = useState<Tab>("preview");
  const [publishing, setPublishing] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [consoleMessages, setConsoleMessages] = useState<GameConsoleMessage[]>([]);
  const [copied, setCopied] = useState(false);
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
  // Rotate toggle (2026-07-16) — only meaningful for orientable presets
  // (tablet/phone); laptop is fixed-landscape, fit has no shape at all.
  const [orientation, setOrientation] = useState<PreviewOrientation>("portrait");
  const previewBoxRef = useRef<HTMLDivElement>(null);
  const [panelSize, setPanelSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    setDevice("fit"); // new game → verify at panel size
    setOrientation("portrait");
  }, [html]);

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
  // The SDK stub keeps multiplayer-prompt rule 9's promise ("Ariantra always
  // exists, in the preview too") for the PREVIEW ONLY — publish/invite send
  // state.currentHtml untouched, where the platform loads the real SDK.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const srcDoc = useMemo(
    () =>
      state.probesEnabled
        ? injectPreviewInstrumentation(injectPreviewSdkStub(state.currentHtml))
        : injectConsoleCapture(injectPreviewSdkStub(state.currentHtml)),
    [docKey],
  );
  const covered = state.phase !== "done";

  // Device frame's actual ON-SCREEN box (2026-07-16 fix): shared by the
  // iframe wrapper AND the Idea Button/Bag overlays below. The overlays
  // used to be siblings of this box positioned relative to the FULL panel —
  // fine at "Fit", but whenever a framed preset (Tablet/Phone/Laptop) scaled
  // DOWN to fit a wider panel, the frame's rendered box was smaller than the
  // panel, and the overlays (anchored to the panel's own edges) landed
  // outside the actual visible game area, on the gray backdrop. Computing the
  // frame's real post-scale rect here lets the overlays share it instead.
  const previewPreset = deviceById(device);
  const previewOriented = orientedSize(previewPreset, orientation);
  const previewFramed = previewOriented.width !== null && previewOriented.height !== null;
  const previewScale = previewFramed
    ? fitScale(panelSize.w - 24, panelSize.h - 24, previewOriented.width!, previewOriented.height!)
    : 1;
  const previewVisibleW = previewFramed ? previewOriented.width! * previewScale : panelSize.w;
  const previewVisibleH = previewFramed ? previewOriented.height! * previewScale : panelSize.h;
  const previewVisibleLeft = previewFramed ? Math.max(0, (panelSize.w - previewVisibleW) / 2) : 0;
  const previewVisibleTop = previewFramed ? Math.max(0, (panelSize.h - previewVisibleH) / 2) : 0;

  // Track the panel's size in EVERY device mode — not just while a device
  // frame is shown. previewVisibleLeft/Top and the Idea Button/Bag overlay's
  // width/height (below) fall back to panelSize.w/h whenever previewFramed
  // is false (the default "fit" mode, reset on every new game — see the
  // effect above), so skipping measurement in "fit" left panelSize stuck at
  // its initial {0,0} forever: the overlay got width:0/height:0 and the idea
  // mic button/bag were rendered but invisible on every ordinary game preview
  // (BUG-FIX-LOG 2026-07-18, "the idea mic button is not visible").
  useEffect(() => {
    const el = previewBoxRef.current;
    if (!el) return;
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
  // "Something unexpected happened" — the game threw, or verify gave up.
  // Only then are grown-up details reachable (owner request 2026-07-20): the
  // console came back for real failures, still never on a healthy game.
  const extremeError = hasExtremeError({ outcome: state.outcome, errors: consoleMessages });
  const consoleAvailable = debug || extremeError;

  const copyErrorReport = async () => {
    const report = buildErrorReport({
      gameTitle: titleOf(state.currentHtml) || undefined,
      outcome: state.outcome,
      failureCode: state.question ? "verify_failed" : null,
      errors: consoleMessages,
      userAgent: typeof navigator === "undefined" ? undefined : navigator.userAgent,
      at: new Date().toISOString(),
    });
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      // Clipboard blocked (permissions/older browser): open the console tab
      // so the details are at least selectable by hand — never a dead end.
      setTab("console");
    }
  };

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
          {consoleAvailable && (
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
          {/* Invite a friend to test (PRD-MULTIPLAYER.md Phase 4) — ONLY for
              games the model actually built multiplayer (MULTIPLAYER_MARKER);
              on any other game this button would be a dead end (no friend
              session to join). Sits before Arcade — testing comes before
              publishing. */}
          {!busy && state.currentHtml.includes(MULTIPLAYER_MARKER) && (
            <button
              onClick={() => setInviting(true)}
              className="rounded-full border-2 border-orange-500 px-3 py-1.5 text-sm font-extrabold text-orange-600"
              aria-label="Invite a friend to test"
            >
              🎮 <span className="hidden sm:inline">Invite</span>
            </button>
          )}
          {/* Publish lives HERE (not a bar under the game — that sat exactly on
              kids' on-screen controls). Compact pill, hidden while streaming. */}
          {!busy && (
            <button
              onClick={() => setPublishing(true)}
              className="rounded-full bg-orange-500 px-3 py-1.5 text-sm font-extrabold text-white shadow shadow-orange-500/30"
              aria-label="Publish"
            >
              🚀 <span className="hidden sm:inline">Publish</span>
            </button>
          )}
          {/* Full-screen toggle — the main view control for this panel, so it
              gets the prominent treatment (labeled pill, not a bare glyph).
              md+ only (mobile is already full screen). Disabled while the
              verify cover is up, same reason as the device switcher: the
              probes must measure the game at a stable size. */}
          {onToggleExpand && (
            <button
              onClick={onToggleExpand}
              disabled={covered}
              className="btn-ghost hidden !min-h-0 gap-1.5 !px-3 !py-1.5 text-sm font-semibold disabled:opacity-40 md:inline-flex"
              aria-label={expanded ? "Exit full screen" : "Full screen"}
              aria-pressed={expanded}
              title={expanded ? "Exit full screen (Esc)" : "Full screen"}
            >
              {expanded ? "⤡" : "⤢"} {expanded ? "Exit Full Screen" : "Full Screen"}
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
            {/* Rotate (2026-07-16) — landscape preview for tablet/phone.
                ALWAYS rendered (disabled, not hidden, for non-orientable
                Fit/Laptop) — hiding it entirely meant it only appeared AFTER
                first picking Tablet/Phone, so nobody discovered it existed.
                2026-07-17: the icon was a lone 12px glyph with no visible
                label — the `title` tooltip it relied on for meaning never
                shows on touch, so on a phone it just looked like a tiny,
                unlabeled mark. Bigger icon + a real label + a rotating
                animation that mirrors the actual state fix both. */}
            <button
              onClick={() => setOrientation((o) => (o === "portrait" ? "landscape" : "portrait"))}
              disabled={covered || !deviceById(device).orientable}
              title={
                !deviceById(device).orientable
                  ? "Pick Tablet or Phone to rotate"
                  : orientation === "portrait"
                    ? "Rotate to landscape"
                    : "Rotate to portrait"
              }
              aria-label={orientation === "portrait" ? "Rotate to landscape" : "Rotate to portrait"}
              aria-pressed={orientation === "landscape"}
              className="flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium text-neutral-500 hover:bg-neutral-100 disabled:opacity-40"
            >
              <span
                aria-hidden
                className={`text-base leading-none transition-transform ${orientation === "landscape" ? "rotate-90" : ""}`}
              >
                ⟳
              </span>
              <span className="hidden sm:inline">Rotate</span>
            </button>
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
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-orange-100 bg-orange-50 px-4 py-2 text-sm text-orange-800">
          <span>{state.question}</span>
          {/* Grown-up escape hatch (owner request 2026-07-20): one tap puts
              the whole diagnosis on the clipboard — no stack trace shown to
              the kid unless they open the console tab themselves. */}
          <button
            onClick={copyErrorReport}
            className="shrink-0 rounded-full border border-orange-300 px-3 py-1 text-xs font-semibold text-orange-800 hover:bg-orange-100"
            title="Copy the technical details for a grown-up"
          >
            {copied ? "✓ Copied" : "📋 Copy error details"}
          </button>
        </div>
      )}

      {tab === "preview" && (
        <div
          ref={previewBoxRef}
          className={`relative flex min-h-0 w-full flex-1 items-center justify-center overflow-hidden ${
            device === "fit" ? "" : "bg-neutral-100"
          }`}
        >
          {/* One stable wrapper around ONE stable iframe — switching device
              restyles, never remounts (a remount would reload the game). */}
          <div
            className={
              previewFramed
                ? "shrink-0 overflow-hidden rounded-kid border border-neutral-200 bg-white shadow-md"
                : "h-full w-full"
            }
            style={
              previewFramed
                ? {
                    width: previewOriented.width!,
                    height: previewOriented.height!,
                    transform: `scale(${previewScale})`,
                  }
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
          {/* Idea Button overlays (docs/PRD-IDEA-BUTTON.md): the mic tab docks
              on the preview edge — the ONLY capture path while the composer is
              hidden (full screen / mobile). Hidden during the verify cover so
              probes measure a clean game, and capture never fights the tester.
              Positioned AND SCALED to match the frame's actual on-screen box
              (2026-07-16 fix), not the full outer panel: sized to the preset's
              real (pre-scale) dimensions, then scaled by the SAME factor as
              the iframe itself (transform-origin top-left, anchored at the
              frame's visual top-left corner) — otherwise a scaled-down framed
              preset (Tablet/Phone/Laptop smaller than the panel) either left
              these anchored to the panel's edges outside the visible game
              area, or (once repositioned) rendered the fixed-size button at
              full 48px regardless of zoom — proportionally oversized next to
              a shrunk-down simulated phone, unlike how it'd truly look at
              real device size. Real devices (unsimulated, scale 1) are
              unaffected — the button stays a fixed, accessible touch target. */}
          <div
            className="pointer-events-none absolute"
            style={{
              left: previewVisibleLeft,
              top: previewVisibleTop,
              width: previewFramed ? previewOriented.width! : panelSize.w,
              height: previewFramed ? previewOriented.height! : panelSize.h,
              transform: previewFramed ? `scale(${previewScale})` : undefined,
              transformOrigin: "top left",
            }}
          >
            <div className="relative h-full w-full [&>*]:pointer-events-auto">
              {!covered && onCaptureIdea && (
                <IdeaMicTab
                  onIdea={onCaptureIdea}
                  ideas={ideas}
                  onMakeBetter={onMakeBetter}
                  busy={busy}
                  coach={coach}
                  onCoachDone={onCoachDone}
                  nudge={nudgeMic}
                  onNudgeShown={onNudgeShown}
                />
              )}
              {!covered && ideas && onDiscardIdea && onEditIdea && onMakeBetter && (
                <IdeaBag
                  ideas={ideas}
                  busy={busy}
                  onDiscard={onDiscardIdea}
                  onEditIdea={onEditIdea}
                  onMakeBetter={onMakeBetter}
                />
              )}
            </div>
          </div>
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
      {tab === "console" && consoleAvailable && (
        <div className="flex items-center justify-between gap-2 border-b border-neutral-800 bg-neutral-950 px-3 py-2">
          <span className="font-mono text-[11px] uppercase tracking-wider text-neutral-500">
            Error details · for a grown-up
          </span>
          <button
            onClick={copyErrorReport}
            className="rounded-full border border-neutral-700 px-3 py-1 text-xs font-semibold text-neutral-200 hover:bg-neutral-800"
          >
            {copied ? "✓ Copied" : "📋 Copy all"}
          </button>
        </div>
      )}
      {tab === "console" && consoleAvailable && (
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

      {inviting && (
        <InviteToTest html={state.currentHtml} suggestedName={titleOf(state.currentHtml)} onClose={() => setInviting(false)} />
      )}
    </aside>
  );
}
