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

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { PublishToArcade } from "./PublishToArcade";
import { InviteToTest } from "./InviteToTest";
import { MULTIPLAYER_MARKER } from "@/lib/multiplayer-gate";
import { GAME_CONSOLE_SOURCE, injectConsoleCapture } from "@/lib/game-console";
import { DEVICE_PRESETS, deviceById, fitScale, orientedSize } from "@/lib/device-preview";
import { injectPreviewInstrumentation } from "@/lib/preview-verify";
import { shouldAutoFocusPreview } from "@/lib/preview-focus";
import { injectPreviewRuntime, type PreviewTheme } from "@/lib/preview-runtime";
import { ensureAssetRuntime } from "@/lib/assets/ensure-runtime";
import { keyToPanelAction, previewDisplay, UPDATING_LINE } from "@/lib/preview-pane";
import { buildErrorReport, hasExtremeError } from "@/lib/error-report";
import { usePreviewVerify } from "./usePreviewVerify";
import { usePerfProbe } from "./usePerfProbe";
import { useGameSaveChannel } from "./useGameSaveChannel";
import { injectInitialGameState } from "@/lib/game-save-inject";
import {
  buildSlowdownHint,
  initialSlowdownBannerState,
  nextSlowdownBannerState,
} from "@/lib/slowdown-nudge";
import { buildSlowGameReport, reportSlowGame } from "@/lib/perf-report";
import type { LoadBucket } from "@/types/preview-perf.types";
import { IdeaMicTab } from "./IdeaMicTab";
import { IdeaQueue } from "./IdeaQueue";
import type { QueueHold, QueuedIdea } from "@/types/idea-queue.types";
import type { GameConsoleMessage } from "@/types/game-console.types";
import type { PreviewDeviceId, PreviewOrientation } from "@/types/device-preview.types";
import type { VerifyCheckId } from "@/types/preview-verify.types";

interface ArtifactFrameProps {
  html: string | null;
  /** True while the reply is still streaming — publish waits for the full game. */
  busy?: boolean;
  /** Sparks exhaustion (2026-08-07, platform PRD-SPARKS trial amendment):
      true ⇒ the preview is covered by a buy-Sparks card until a pack is
      bought. Sits above the verify cover — an out-of-Sparks kid sees the
      paywall, not "Testing your game…". */
  sparksLocked?: boolean;
  /** Owner funnel 2026-08-08: a signed-out visitor's one free build renders
      behind THIS cover — "Your game is ready! Sign in free to see it."
      Highest-priority cover (a guest can't be sparks-locked). */
  signInLocked?: boolean;
  onSignIn?: () => void;
  /** The kid's ask that produced this game — repair prompts carry it (§7). */
  originalRequest?: string;
  onClose: () => void;
  /** Desktop full-screen toggle (PRD-PREVIEW-PANE) — owned by the container,
      which restyles the panel wrapper; this component only shows the button. */
  expanded?: boolean;
  onToggleExpand?: () => void;
  /** 🎤 Idea capture (docs/PRD-IDEA-QUEUE-V2.md) — the mic tab hands finished
      transcripts to the Idea Queue as `tweak` rows. Returns whether the line
      accepted it; on false the bar keeps the transcript and says why.
      Absent prop = feature hidden. */
  onCaptureIdea?: (text: string) => boolean;
  /** The Idea Queue, mirrored INTO the preview (PRD v2 §4.2): on mobile and
      full-screen desktop this panel covers the chat entirely, so the line —
      and especially its held "still want these?" state — must be visible and
      answerable from here. Chip in the header; tap → bottom sheet. */
  queuedIdeas?: QueuedIdea[];
  queueHold?: QueueHold;
  queueSettling?: boolean;
  onEditQueued?: (id: string, text: string) => void;
  onDropQueued?: (id: string) => void;
  onResumeQueue?: () => void;
  onDropAllQueued?: () => void;
  onQueueSendNow?: () => void;
  /** Overrides the generic "Making your update…" banner while a QUEUED idea
      builds — narrates which one, so the eventual game swap is never silent. */
  updatingLine?: string;
  /** First-run coach + one-time re-nudge (policy in the container; the tab
      renders them, so covered/unsupported states are enforced structurally). */
  coach?: boolean;
  onCoachDone?: () => void;
  nudgeMic?: boolean;
  onNudgeShown?: () => void;
  /** A transcript the mic tab was mid-capturing when a verify/repair cover
   *  unmounted it (BUG-FIX-LOG draft-recovery) — restored into the review
   *  bar on the next mount instead of silently dropped. */
  pendingIdeaDraft?: string | null;
  onIdeaInterrupted?: (text: string) => void;
  onIdeaDraftConsumed?: () => void;
  /** 🆘 Community Help tab (docs/PRD-COMMUNITY-HELP.md §3.2), rendered in the
   *  same overlay box as the 🎤 Idea tab so it tracks the scaled device frame.
   *  A SLOT rather than props: the tab's own state (sheet, mic, nudge) belongs
   *  to the container, and this panel stays presentational. Absent = flag off. */
  helpTab?: React.ReactNode;
  /** Reported once per generation, when the verify/repair loop settles: what
   *  the machine concluded, plus the SAME bounded diagnosis the grown-up
   *  "copy error details" button produces. The container needs both — to decide
   *  whether to nudge toward a human (lib/stuck-signal.ts) and to attach the
   *  report to a 🆘 ticket without ever attaching game source. */
  onDiagnostics?: (d: {
    generationId: string;
    verifyFailed: boolean;
    repairAttempts: number;
    errorReport: string | null;
    verifyVerdict: string | null;
  }) => void;
  /** Which themed leaderboard seed the preview WYSIWYG runtime uses
   *  (PRD-PREVIEW-WYSIWYG): 'bible' on the bible-teacher surface, else 'default'. */
  previewTheme?: PreviewTheme;
  /** Bible-teacher surface (PRD-BIBLE-TEACHER §5): publishing fixes the game to
   *  the "Bible games" category and the separate listing. Server re-verifies. */
  bibleTeacher?: boolean;
  /** Edit-a-launched-game (PRD-STUDIO-CHAT-EDIT rev 2026-07-24): this chat is
   *  bound to a published game — Publish opens as an update of that slug and
   *  the button reads "Publish update". */
  editTarget?: { slug: string; name: string };
  /** The active conversation's id — rides on publish so the platform stamps
   *  the chat ↔ game link behind Studio's Edit deep link. */
  chatId?: string;
  /** Save & continue building (docs/2026-08-01_PRD_SaveContinueBuilding.md):
   *  the conversation + the SPECIFIC message this game belongs to (never
   *  assumed to be the newest — "Continue from here" can pin an older one).
   *  Either absent = feature inert, same convention as onCaptureIdea/helpTab. */
  conversationId?: string;
  messageId?: string;
  /** Kid-facing "🐢 running slow" banner (docs/2026-07-30_PRD_PreviewPerfPanel.md
   *  addendum): tapping "Make it faster" hands a REAL technical hint string
   *  (built from the latest perf snapshot's heaviest model — never shown to
   *  the kid) up to the container, which sends it through the ordinary
   *  handleSend chat pipeline like any other turn. Absent prop = feature
   *  hidden, same convention as onCaptureIdea/helpTab. */
  onFixSlowdown?: (hint: string) => void;
}

type Tab = "preview" | "code" | "console" | "perf";

/** Perf tab colour chips (docs/2026-07-30_PRD_PreviewPerfPanel.md) — owner
 *  decision: colour is by LOAD, never "cost" (that word implies money). */
const BUCKET_STYLES: Record<LoadBucket, string> = {
  green: "bg-emerald-500",
  yellow: "bg-amber-500",
  red: "bg-red-500",
};

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
  sparksLocked,
  signInLocked,
  onSignIn,
  originalRequest,
  onClose,
  expanded,
  onToggleExpand,
  onCaptureIdea,
  queuedIdeas,
  queueHold = null,
  queueSettling,
  onEditQueued,
  onDropQueued,
  onResumeQueue,
  onDropAllQueued,
  onQueueSendNow,
  updatingLine,
  coach,
  onCoachDone,
  nudgeMic,
  onNudgeShown,
  pendingIdeaDraft,
  onIdeaInterrupted,
  onIdeaDraftConsumed,
  helpTab,
  onDiagnostics,
  previewTheme = "default",
  bibleTeacher = false,
  editTarget,
  chatId,
  conversationId,
  messageId,
  onFixSlowdown,
}: ArtifactFrameProps) {
  const [tab, setTab] = useState<Tab>("preview");
  const [publishing, setPublishing] = useState(false);
  const [inviting, setInviting] = useState(false);
  // Fullscreen decluttering: kids in full screen mostly touch two things —
  // Exit Full Screen and the Idea mic tab (which floats over the game, not
  // in this bar). Everything else (tabs, device switcher, Rotate, Publish,
  // Invite, Close) moves into this overflow menu so the header shrinks to
  // one thin bar instead of the two full-width bars split view uses.
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!overflowOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) setOverflowOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [overflowOpen]);
  // ⏳ chip → bottom sheet with the waiting line (PRD-IDEA-QUEUE-V2 §4.2).
  const [queueOpen, setQueueOpen] = useState(false);
  const queueCount = queuedIdeas?.length ?? 0;
  useEffect(() => {
    if (queueCount === 0) setQueueOpen(false); // line drained/dropped — nothing to show
  }, [queueCount]);
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
  // Perf Panel (docs/2026-07-30_PRD_PreviewPerfPanel.md) — debug-only, same
  // gate as the console tab. Harmless to mount unconditionally: it's just a
  // message listener until a snapshot arrives, and the injected probe script
  // (ensure-runtime.ts) already runs on every 3D game regardless of who's
  // looking, so this never changes what a kid sees.
  const { snapshot: perfSnapshot } = usePerfProbe(docKey);
  // Kid-facing "running slow" banner — the symptom-only sibling of the debug
  // Perf tab above. Pure state machine (lib/slowdown-nudge.ts) driven by each
  // incoming snapshot's fps; the reducer owns the sustained-low debounce and
  // the post-tap cooldown so this component just wires events in.
  const [slowdownState, dispatchSlowdown] = useReducer(nextSlowdownBannerState, initialSlowdownBannerState);
  useEffect(() => {
    dispatchSlowdown({ type: "reset" });
  }, [docKey]);
  useEffect(() => {
    if (!perfSnapshot) return;
    dispatchSlowdown({ type: "sample", fps: perfSnapshot.fps, now: Date.now(), playing: perfSnapshot.playing });
  }, [perfSnapshot]);
  // Server-visible logging (2026-08-04): the instant the banner FLIPS to
  // visible (edge-triggered — reportedRef guards against re-firing on every
  // render while it stays visible), tell the server so a sustained slowdown
  // shows up in pm2 logs, not just this one browser tab. Fire-and-forget;
  // never affects the kid's session either way (lib/perf-report.ts).
  const slowdownReportedRef = useRef(false);
  useEffect(() => {
    if (!slowdownState.visible) {
      slowdownReportedRef.current = false;
      return;
    }
    if (slowdownReportedRef.current) return;
    slowdownReportedRef.current = true;
    reportSlowGame(
      buildSlowGameReport({
        docKey,
        fps: perfSnapshot?.fps ?? 0,
        models: perfSnapshot?.models ?? [],
        conversationId,
        chatId,
        messageId,
      }),
    );
  }, [slowdownState.visible, docKey, perfSnapshot, conversationId, chatId, messageId]);
  function handleFixSlowdown() {
    dispatchSlowdown({ type: "fixTapped", now: Date.now() });
    onFixSlowdown?.(buildSlowdownHint(perfSnapshot?.models ?? []));
  }
  // Pinned per docKey (generation + round): probesEnabled flips false on every
  // finish, and letting srcDoc change without a docKey bump would reload
  // (flash) a game we decided NOT to reload. A new docKey = new document;
  // anything else stays put.
  // Preview WYSIWYG (PRD-PREVIEW-WYSIWYG): the preview runtime inlines the REAL
  // sdk.js + publish overlays (🏆 leaderboard, ⋯ menu, high-score, share) backed
  // by a LOCAL mock, so the preview looks like the published game — and keeps
  // multiplayer-prompt rule 9's promise ("Ariantra always exists, in the preview
  // too") via a solo session. PREVIEW ONLY — publish/🎮 Invite send
  // state.currentHtml untouched, where the platform loads the real backend SDK.
  //
  // ensureAssetRuntime is the innermost floor (BUG-FIX-LOG 2026-07-23): whatever
  // produced currentHtml — a fresh build, a repair patch, or reloading an older
  // chat whose stored HTML predates the fix — a 3D game that imports "three" is
  // guaranteed a resolvable import map here, so the preview iframe can never throw
  // "Failed to resolve module specifier three". Idempotent + 2D-safe.
  // The last version that finished verifying — the game the child can actually
  // play. Kept so an EDIT never takes their working game away while the new
  // version is probed (owner report 2026-08-09; see previewDisplay's note).
  const [lastGoodHtml, setLastGoodHtml] = useState<string | null>(null);
  useEffect(() => {
    if (state.phase === "done" && state.currentHtml) setLastGoodHtml(state.currentHtml);
  }, [state.phase, state.currentHtml]);

  const display = previewDisplay({
    verifyingHtml: state.currentHtml,
    phase: state.phase,
    lastGoodHtml,
  });
  // `covered` now means "there is nothing better to show" — NOT merely
  // "verifying". Mid-verify with a playable game in hand, the child keeps it.
  const covered = display.covered;
  /** True while a new version is being probed behind the game on screen. */
  const shadowing = display.shadowHtml !== null;
  // Save & continue building (docs/2026-08-01_PRD_SaveContinueBuilding.md):
  // active only once the game is up and playable (never mid-verify-cover),
  // so the existing-save lookup and autosave never race the verify loop.
  const gameSave = useGameSaveChannel({
    iframeRef,
    html: state.currentHtml,
    conversationId,
    messageId,
    active: !covered,
  });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const srcDoc = useMemo(() => {
    const floored = ensureAssetRuntime(state.currentHtml);
    const withRuntime = state.probesEnabled
      ? injectPreviewInstrumentation(injectPreviewRuntime(floored, { theme: previewTheme }))
      : injectConsoleCapture(injectPreviewRuntime(floored, { theme: previewTheme }));
    // Only when the kid picked "Continue" (useGameSaveChannel.continueBuild) —
    // reloads THIS SAME iframe (srcDoc changes, docKey/key does not) with the
    // restored world injected before the game's own script runs (§3f).
    return gameSave.injectedState ? injectInitialGameState(withRuntime, gameSave.injectedState) : withRuntime;
  }, [docKey, gameSave.injectedState]);

  // The playable fallback shown OVER the document under test while shadowing.
  // Never instrumented: probes belong to the version being verified, and a
  // second set reporting into the same controller would corrupt its verdict.
  // Memoised on the html itself so the game the child is playing is not
  // reloaded by an unrelated re-render.
  const fallbackSrcDoc = useMemo(
    () => (shadowing && lastGoodHtml
      ? injectConsoleCapture(injectPreviewRuntime(ensureAssetRuntime(lastGoodHtml), { theme: previewTheme }))
      : null),
    [shadowing, lastGoodHtml, previewTheme],
  );

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

  // Keyboard reaches the game only once the iframe holds focus — and nothing
  // was ever giving it focus, so every game started unplayable by arrow
  // keys/WASD until the kid happened to click the preview (owner ask
  // 2026-08-08). Focus it the moment the verify cover lifts and the game is
  // actually playable, re-running per docKey so a rebuild/reload re-arms it.
  //
  // Two deliberate guards: shouldAutoFocusPreview refuses to pull the cursor
  // out of the chat box mid-word (the worse bug), and preventScroll stops the
  // browser scrolling the panel into view under the kid. Cross-origin-safe —
  // focusing the ELEMENT needs no reach into the sandboxed document.
  useEffect(() => {
    if (covered || tab !== "preview") return;
    const el = iframeRef.current;
    if (!el) return;
    const active = document.activeElement as HTMLElement | null;
    if (!shouldAutoFocusPreview(active && { tagName: active.tagName, isContentEditable: active.isContentEditable })) return;
    el.focus({ preventScroll: true });
  }, [covered, docKey, tab, iframeRef]);


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

  // Community Help bridge: hand the settled verdict + the bounded diagnosis up
  // once per generation. Deliberately gated on phase "done" — mid-verify
  // numbers would make the stuck signal fire while the machine is still trying.
  const onDiagnosticsRef = useRef(onDiagnostics);
  onDiagnosticsRef.current = onDiagnostics;
  useEffect(() => {
    if (state.phase !== "done" || !state.outcome) return;
    onDiagnosticsRef.current?.({
      generationId: docKey,
      verifyFailed: state.outcome === "failed" || state.outcome === "bailed",
      repairAttempts: state.repairAttempts,
      errorReport: extremeError
        ? buildErrorReport({
            gameTitle: titleOf(state.currentHtml) || undefined,
            outcome: state.outcome,
            failureCode: state.failureCode,
            errors: consoleMessages,
            userAgent: typeof navigator === "undefined" ? undefined : navigator.userAgent,
            at: new Date().toISOString(),
          })
        : null,
      verifyVerdict: state.failureCode ? `${state.outcome}:${state.failureCode}` : state.outcome,
    });
    // consoleMessages intentionally out of the deps: a late error arriving after
    // the loop settled shouldn't re-report the same generation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase, state.outcome, state.repairAttempts, docKey]);

  // Rules of Hooks: this early return used to sit ~30 lines UP, above the
  // onDiagnostics ref+effect below it — so a caller honouring the declared
  // `html: string | null` contract would render a different number of hooks
  // between renders and crash with "Rendered more hooks than during the
  // previous render". It is latent only because the single call site guards
  // with `{artifact && ...}` (code review 2026-08-09). Every hook now runs
  // unconditionally; the lines between are pure computation.
  if (!html) return null;

  const tabBtn = (t: Tab) =>
    `rounded-full px-3 py-1 text-sm font-medium ${
      tab === t ? "bg-neutral-900 text-white" : "text-neutral-600 hover:bg-neutral-100"
    } disabled:opacity-40`;

  // Shared between the split-view bars and the full-screen overflow menu
  // (below) — the two layouts show the same controls, just grouped
  // differently, so the markup lives once.
  const tabsGroup = (
    <>
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
      {/* Perf tab (docs/2026-07-30_PRD_PreviewPerfPanel.md) — SAME debug gate
          as Console, listed alongside it (never replacing it), never visible
          to a kid. */}
      {debug && (
        <button onClick={() => setTab("perf")} className={tabBtn("perf")} disabled={covered}>
          ⚡ <span className="hidden sm:inline">Perf</span>
        </button>
      )}
    </>
  );

  const deviceSwitcher = tab === "preview" && (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Preview device size">
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
      {/* Rotate (2026-07-16) — landscape preview for tablet/phone. ALWAYS
          rendered (disabled, not hidden, for non-orientable Fit/Laptop) —
          hiding it entirely meant it only appeared AFTER first picking
          Tablet/Phone, so nobody discovered it existed. */}
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
  );

  // Test link (PRD-MULTIPLAYER.md Phase 4; renamed from "🎮 Invite" 2026-08-06:
  // owner UAT — "Invite" read like it starts a multiplayer session, but it
  // mints a temporary try-before-publish link) — ONLY for games the model
  // actually built multiplayer (MULTIPLAYER_MARKER); on any other game this
  // button would be a dead end (no friend session to join).
  const inviteButton = !busy && state.currentHtml.includes(MULTIPLAYER_MARKER) && (
    <button
      onClick={() => setInviting(true)}
      className="rounded-full border-2 border-orange-500 px-3 py-1.5 text-sm font-extrabold text-orange-600"
      aria-label="Get a test link to try this game with a friend"
    >
      🧪 <span className="hidden sm:inline">Test link</span>
    </button>
  );

  const publishButton = !busy && (
    <button
      onClick={() => setPublishing(true)}
      className="rounded-full bg-orange-500 px-3 py-1.5 text-sm font-extrabold text-white shadow shadow-orange-500/30"
      aria-label={editTarget ? "Publish update" : "Publish"}
    >
      🚀 <span className="hidden sm:inline">{editTarget ? "Publish update" : "Publish"}</span>
    </button>
  );

  return (
    <aside className="relative flex h-full w-full flex-col bg-white">
      {expanded ? (
        // Full screen: kids here mostly touch two things — Exit Full Screen
        // and the Idea mic tab (floats over the game, not in this bar). One
        // thin bar instead of split view's two — everything else (tabs,
        // device switcher, Rotate, Publish, Invite, Close) moves into the
        // "•••" overflow menu (BUG: the two full bars ate real estate for
        // controls kids barely touch in full screen).
        <header className="relative flex items-center justify-between gap-2 border-b border-neutral-200 px-4 py-2">
          {onToggleExpand && (
            <button
              onClick={onToggleExpand}
              disabled={covered}
              className="btn-ghost !min-h-0 gap-1.5 !px-3 !py-1.5 text-sm font-semibold disabled:opacity-40"
              aria-label="Exit full screen"
              aria-pressed={true}
              title="Exit full screen (Esc)"
            >
              ⤡ Exit Full Screen
            </button>
          )}
          <div ref={overflowRef} className="flex shrink-0 items-center gap-1">
            {queueCount > 0 && (
              <button
                onClick={() => setQueueOpen(true)}
                aria-label={
                  queueHold
                    ? `Your idea line is paused — ${queueCount} waiting`
                    : `${queueCount} idea${queueCount === 1 ? "" : "s"} lined up`
                }
                title={queueHold ? "Your line is paused — tap to decide" : "Your ideas, lined up"}
                className={`rounded-full px-3 py-1.5 text-sm font-extrabold ${
                  queueHold
                    ? "border-2 border-warn-500 bg-warn-50 text-warn-600"
                    : "border-2 border-brand-300 bg-brand-50 text-brand-600"
                }`}
              >
                {queueHold ? "⏸" : "⏳"} {queueCount}
              </button>
            )}
            <button
              onClick={() => setOverflowOpen((v) => !v)}
              aria-haspopup="true"
              aria-expanded={overflowOpen}
              aria-label="More options"
              className="rounded-full px-3 py-1.5 text-lg font-bold leading-none text-neutral-500 hover:bg-neutral-100"
            >
              •••
            </button>
            {overflowOpen && (
              <div
                role="menu"
                aria-label="More options"
                // Picking a tab shows the result right away — closing here
                // reads as "done choosing." Device/Rotate/Invite/Publish stay
                // open (a kid comparing device sizes, or a modal that's about
                // to cover the screen anyway) — only the tab row closes it.
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest("[data-close-overflow]")) setOverflowOpen(false);
                }}
                // z-50: the Idea mic tab's first-run coach popup (IdeaMicTab)
                // is ALSO z-30 and renders later in the DOM (it's inside the
                // preview area, after this header) — equal z-index falls
                // back to paint order, so the coach card was winning and
                // covering the menu (caught in the visual pass). This menu
                // must always show on top of it while open.
                className="absolute right-2 top-full z-50 mt-1 w-72 max-w-[calc(100vw-1rem)] rounded-kid border border-neutral-200 bg-white p-2 shadow-lg"
              >
                <div data-close-overflow className="flex flex-wrap items-center gap-1 border-b border-neutral-100 pb-2">
                  {tabsGroup}
                </div>
                {deviceSwitcher && <div className="border-b border-neutral-100 py-2">{deviceSwitcher}</div>}
                <div className="flex flex-col gap-1.5 pt-2">
                  {inviteButton}
                  {publishButton}
                  <button
                    data-close-overflow
                    onClick={onClose}
                    className="rounded-lg px-3 py-1.5 text-left text-sm text-neutral-600 hover:bg-neutral-100"
                  >
                    ✕ Close preview
                  </button>
                </div>
              </div>
            )}
          </div>
        </header>
      ) : (
        <>
          <header className="flex items-center justify-between gap-2 border-b border-neutral-200 px-4 py-2.5">
            <div className="flex items-center gap-2">
              {/* Mobile-only: the frame covers the whole screen there, so give
                  an explicit way back to the conversation (✕ alone wasn't
                  found). */}
              <button
                onClick={onClose}
                className="rounded-lg px-2 py-1 text-sm font-medium text-neutral-600 hover:bg-neutral-100 md:hidden"
                aria-label="Back to chat"
              >
                ← Chat
              </button>
              {tabsGroup}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {/* The Idea Queue chip (PRD-IDEA-QUEUE-V2 §4.2): the line's
                  presence and state, visible from INSIDE the game. Hidden on
                  desktop split view (the card is right there beside the
                  panel); shown on mobile, where this panel covers the chat.
                  A held line shows ⏸ in warn tint — a stalled queue must
                  never be invisible. */}
              {queueCount > 0 && (
                <button
                  onClick={() => setQueueOpen(true)}
                  aria-label={
                    queueHold
                      ? `Your idea line is paused — ${queueCount} waiting`
                      : `${queueCount} idea${queueCount === 1 ? "" : "s"} lined up`
                  }
                  title={queueHold ? "Your line is paused — tap to decide" : "Your ideas, lined up"}
                  className={`rounded-full px-3 py-1.5 text-sm font-extrabold md:hidden ${
                    queueHold
                      ? "border-2 border-warn-500 bg-warn-50 text-warn-600"
                      : "border-2 border-brand-300 bg-brand-50 text-brand-600"
                  }`}
                >
                  {queueHold ? "⏸" : "⏳"} {queueCount}
                </button>
              )}
              {inviteButton}
              {publishButton}
              {/* Full-screen toggle — the main view control for this panel,
                  so it gets the prominent treatment (labeled pill, not a bare
                  glyph). md+ only (mobile is already full screen). Disabled
                  while the verify cover is up, same reason as the device
                  switcher: the probes must measure the game at a stable
                  size. */}
              {onToggleExpand && (
                <button
                  onClick={onToggleExpand}
                  disabled={covered}
                  className="btn-ghost hidden !min-h-0 gap-1.5 !px-3 !py-1.5 text-sm font-semibold disabled:opacity-40 md:inline-flex"
                  aria-label="Full screen"
                  aria-pressed={false}
                  title="Full screen"
                >
                  ⤢ Full Screen
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
            {/* Device switcher: "how does it look on a phone?" — resizes the
                SAME iframe (no reload); disabled while the verify cover is up
                so the probes always measure the game at panel size. */}
            {deviceSwitcher}
          </div>
        </>
      )}

      {/* PRD-PREVIEW-PANE §2 — an update is streaming in the chat: the game on
          screen is the PREVIOUS version, still fully playable. Say so, so it
          reads as deliberate rather than stale. */}
      {busy && tab === "preview" && (
        <div className="border-b border-sky-100 bg-sky-50 px-4 py-1.5 text-sm text-sky-800">
          <span className="mr-1 inline-block animate-bounce" aria-hidden>🛠️</span>
          {/* A QUEUED idea building gets named (PRD-IDEA-QUEUE-V2 §4.2) — the
              game swap that follows must be narrated, never a silent switch. */}
          {updatingLine ?? UPDATING_LINE}
        </div>
      )}

      {/* Save & continue building (docs/2026-08-01_PRD_SaveContinueBuilding.md
          §3f): a save was found for this exact game message — ask before
          resuming (a kid reopening to unexpectedly-full build state is a
          surprise, never silently resumed). Never covers a busy/streaming
          update or the verify cover (gameSave.isActive already excludes
          those via the `active: !covered` gate above). */}
      {gameSave.decisionPhase === "pending" && tab === "preview" && !covered && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-brand-100 bg-brand-50 px-4 py-2 text-sm text-brand-600">
          <span>🧱 Continue your build from where you left off?</span>
          <div className="flex shrink-0 gap-2">
            <button
              onClick={gameSave.startFresh}
              className="rounded-full border border-brand-300 px-3 py-1 text-xs font-semibold text-brand-600 hover:bg-brand-100"
            >
              Start fresh
            </button>
            <button
              onClick={gameSave.continueBuild}
              className="rounded-full bg-brand-500 px-3 py-1 text-xs font-extrabold text-white hover:bg-brand-600"
            >
              Continue
            </button>
          </div>
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
            {/* Two iframes, one job each (owner report 2026-08-09).
                UNDER TEST: always mounted and ALWAYS PAINTING — opacity, never
                display:none, because rAF stops in a hidden frame and the probes
                would "repair" a healthy game. It carries iframeRef, so the
                controller talks to it whether it is on screen or behind the
                fallback. Promotion is just the fallback unmounting, so the new
                game never reloads at the swap.
                PLAYABLE: the last verified version, layered on top while a new
                one is probed, so an edit never costs the child their game. */}
            <div className="relative h-full w-full">
              <iframe
                key={docKey} // bumps per game generation AND per verify round (incl. the pristine reload after a probe-click clean)
                ref={iframeRef}
                title={shadowing ? "Testing the updated game" : "AI-generated game"}
                sandbox="allow-scripts"
                srcDoc={srcDoc}
                onLoad={onIframeLoad}
                aria-hidden={shadowing}
                className={`absolute inset-0 h-full w-full border-0 ${
                  shadowing ? "pointer-events-none opacity-0" : ""
                }`}
              />
              {fallbackSrcDoc && (
                <iframe
                  // Keyed on the game itself: re-renders while the child plays
                  // must not reload it, but a NEW fallback must be a new document.
                  key={`play:${lastGoodHtml?.length ?? 0}`}
                  title="AI-generated game"
                  sandbox="allow-scripts"
                  srcDoc={fallbackSrcDoc}
                  className="absolute inset-0 h-full w-full border-0"
                />
              )}
            </div>
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
              {/* 🐢 Running-slow banner (docs/2026-07-30_PRD_PreviewPerfPanel.md
                  addendum) — always-visible (no debug flag), unlike the Perf
                  tab. Symptom-only copy, no model names or numbers; the real
                  technical context rides silently into chat via
                  onFixSlowdown. Same "float over the preview" convention as
                  the mic/help tabs, docked top-center so it doesn't collide
                  with either (both dock at the right edge). Hidden during the
                  verify cover, same as every other overlay here. */}
              {!covered && onFixSlowdown && slowdownState.visible && (
                <div
                  role="status"
                  className="absolute left-1/2 top-3 z-20 flex w-[min(320px,88%)] -translate-x-1/2 items-center gap-2 rounded-kid border-2 border-amber-200 bg-amber-50 px-3 py-2 shadow-md"
                >
                  <span className="text-lg leading-none" aria-hidden>
                    🐢
                  </span>
                  <p className="flex-1 text-sm font-extrabold leading-snug text-amber-900">
                    This game is running slow
                  </p>
                  <button
                    type="button"
                    onClick={handleFixSlowdown}
                    className="shrink-0 rounded-full bg-amber-500 px-3 py-1.5 text-xs font-extrabold text-white hover:bg-amber-600"
                  >
                    Make it faster
                  </button>
                </div>
              )}
              {!covered && onCaptureIdea && (
                <IdeaMicTab
                  onIdea={onCaptureIdea}
                  queued={queuedIdeas}
                  coach={coach}
                  onCoachDone={onCoachDone}
                  nudge={nudgeMic}
                  onNudgeShown={onNudgeShown}
                  pendingDraft={pendingIdeaDraft}
                  onDraftConsumed={onIdeaDraftConsumed}
                  onInterrupted={onIdeaInterrupted ?? (() => {})}
                />
              )}
              {/* Same gate as the mic tab: never over the verify/repair cover. */}
              {!covered && helpTab}
            </div>
          </div>
          {/* Sign-in lock (owner funnel 2026-08-08): the guest's one free
              build renders under this cover — the hook is "it's READY, sign
              in to see it". Chats are server-claimed into the account on
              login, so nothing is lost by signing in. Highest cover. */}
          {signInLocked && (
            <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-white px-6 text-center">
              <span className="text-4xl" aria-hidden>🎉</span>
              <p className="text-lg font-semibold text-neutral-800">Your game is ready!</p>
              <p className="max-w-xs text-sm text-neutral-600">
                Sign in free to see it and play — you'll keep this game forever and get 2,000 free Sparks to keep building.
              </p>
              <button
                onClick={onSignIn}
                className="rounded-full bg-neutral-800 px-5 py-3 text-base font-medium text-white hover:bg-neutral-700"
              >
                🔆 Sign in to see your game
              </button>
            </div>
          )}

          {/* Sparks exhaustion lock (2026-08-07): above the verify cover — an
              out-of-Sparks kid sees the paywall, not "Testing your game…".
              The game stays SAFE underneath (nothing is deleted); it unlocks
              the moment a pack lands. */}
          {sparksLocked && (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-white px-6 text-center">
              <span className="text-4xl" aria-hidden>⚡</span>
              <p className="text-lg font-semibold text-neutral-800">Your Sparks are over!</p>
              <p className="max-w-xs text-sm text-neutral-600">
                Your game is saved and waiting — nothing is lost. Ask a grown-up to add Sparks so you can keep playing and finish building it!
              </p>
              {/* sparks.html parent promise: "never a buy button" AT the kid —
                  the CTA is addressed to the grown-up and lands on /upgrade,
                  where top-ups happen on the account as promised. */}
              <a
                href="/upgrade"
                className="rounded-full bg-neutral-800 px-5 py-3 text-base font-medium text-white hover:bg-neutral-700"
              >
                ⚡ Add Sparks (grown-ups)
              </a>
            </div>
          )}

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
      {/* Perf tab (docs/2026-07-30_PRD_PreviewPerfPanel.md) — debug-only,
          same gate as Console. Overall FPS/draw-calls line, then a
          highest-load-first per-model list. A model with zero live instances
          is never in the snapshot (the probe drops it — no stale rows). */}
      {tab === "perf" && debug && (
        <div className="min-h-0 flex-1 overflow-auto bg-neutral-950 p-3 font-mono text-[12px] leading-5 text-neutral-300">
          {!perfSnapshot ? (
            <p className="text-neutral-500">No perf reading yet — play the game for a second to see one.</p>
          ) : (
            <>
              <div className="mb-3 border-b border-neutral-800 pb-2 text-neutral-100">
                {perfSnapshot.fps} fps
                {perfSnapshot.drawCalls !== null && <> · {perfSnapshot.drawCalls} draw calls</>}
                {perfSnapshot.rendererTriangles !== null && (
                  <> · {perfSnapshot.rendererTriangles.toLocaleString()} triangles</>
                )}
              </div>
              {perfSnapshot.models.length === 0 ? (
                <p className="text-neutral-500">No models currently loaded.</p>
              ) : (
                <table className="w-full border-collapse text-left">
                  <thead>
                    <tr className="text-neutral-500">
                      <th className="pb-1 pr-3 font-normal">Model</th>
                      <th className="pb-1 pr-3 font-normal">Instances</th>
                      <th className="pb-1 pr-3 font-normal">Triangles</th>
                      <th className="pb-1 pr-3 font-normal">Animated</th>
                      <th className="pb-1 font-normal">Load</th>
                    </tr>
                  </thead>
                  <tbody>
                    {perfSnapshot.models.map((m) => (
                      <tr key={m.name} className="border-t border-neutral-800">
                        <td className="py-1 pr-3">{m.name}</td>
                        <td className="py-1 pr-3">{m.instances}</td>
                        <td className="py-1 pr-3">{m.triangles.toLocaleString()}</td>
                        <td className="py-1 pr-3">{m.animated ? "yes" : "no"}</td>
                        <td className="py-1">
                          <span
                            aria-label={`${m.bucket} load`}
                            title={`${m.bucket} load`}
                            className={`inline-block h-2.5 w-2.5 rounded-full ${BUCKET_STYLES[m.bucket]}`}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      )}

      {/* The queue sheet (PRD-IDEA-QUEUE-V2 §4.2): the SAME IdeaQueue the chat
          card renders, so edit/drop/resume — including the held "still want
          these?" decision — work without leaving the game. Bottom sheet on
          mobile, centered card on md+ (IdeaBag's former pattern). */}
      {queueOpen && queueCount > 0 && onEditQueued && onDropQueued && onResumeQueue && onDropAllQueued && (
        <div
          className="absolute inset-0 z-30 bg-ink-900/30"
          onClick={() => setQueueOpen(false)}
          role="dialog"
          aria-label="Your idea line"
        >
          <div
            className="absolute inset-x-3 bottom-3 max-h-[70%] overflow-y-auto rounded-kid bg-white p-3 shadow-lg
              md:inset-x-auto md:bottom-auto md:left-1/2 md:top-1/2 md:max-h-[80%] md:w-[440px] md:-translate-x-1/2 md:-translate-y-1/2"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setQueueOpen(false)}
              aria-label="Close"
              className="absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-full text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600"
            >
              ✕
            </button>
            <IdeaQueue
              variant="sheet"
              ideas={queuedIdeas!}
              hold={queueHold}
              settling={queueSettling}
              onSendNow={onQueueSendNow}
              onEdit={onEditQueued}
              onDrop={onDropQueued}
              onResume={onResumeQueue}
              onDropAll={onDropAllQueued}
            />
          </div>
        </div>
      )}

      {publishing && (
        <PublishToArcade html={state.currentHtml} suggestedName={titleOf(state.currentHtml)} bibleGame={bibleTeacher} editTarget={editTarget} chatId={chatId} onClose={() => setPublishing(false)} />
      )}

      {inviting && (
        <InviteToTest html={state.currentHtml} suggestedName={titleOf(state.currentHtml)} onClose={() => setInviting(false)} />
      )}
    </aside>
  );
}
