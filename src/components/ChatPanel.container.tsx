"use client";
// Container: owns conversations + chat state, talks to /api/chat (the safety boundary),
// and drives the sidebar, message list (markdown + read-aloud), composer, and artifact panel.
// Naming: `.container.tsx` = data-fetching component (CLAUDE.md § 5).

import { useEffect, useMemo, useRef, useState } from "react";
import { signIn, verifyAge, useSession } from "@/lib/useAriantraSession";
import { Sidebar } from "./Sidebar";
import { Composer, type Attachment } from "./Composer";
import { ArtifactFrame } from "./ArtifactFrame";
import { MessageItem } from "./MessageItem";
import { LoginGate } from "./LoginGate";
import { useTextToSpeech } from "./useTextToSpeech";
import type { ChatMessage, Conversation, Workspace } from "@/types/chat.types";
import type { QueuedIdea } from "@/types/idea-queue.types";
import type { IdeaRecord } from "@/types/idea-bag.types";
import { loadChats, saveChats } from "@/lib/chat-store";
import { canContinueFromHere } from "@/lib/chat-rewind";
// Never render raw SEARCH/REPLACE hunks mid-stream (BUG-FIX-LOG 2026-07-18
// "not kid friendly") — every partial-text render goes through this.
import { streamingDisplayText } from "@/lib/game-edit";
import {
  addIdea,
  baggedFor,
  composeIdeaBundle,
  discardIdea,
  ideaQueueAction,
  loadIdeas,
  markSent,
  saveIdeas,
  updateIdeaText,
} from "@/lib/idea-bag";
import {
  canQueue,
  enqueueIdea,
  queueSendAction,
  removeQueuedIdea,
  takeNextIdea,
  updateQueuedIdea,
} from "@/lib/idea-queue";
import { IdeaQueue } from "./IdeaQueue";
import {
  defaultCoachStore,
  loadCoach,
  saveCoach,
  shouldRenudge,
  shouldShowCoach,
  type CoachStore,
} from "@/lib/idea-coach";
import {
  clampPanelWidth,
  type ExpandState,
  loadPanelWidth,
  nextArtifact,
  nextExpandOnManualToggle,
  PANEL_DEFAULT_W,
  panelShellClass,
  savePanelWidth,
} from "@/lib/preview-pane";
import { PanelResizeHandle } from "./PanelResizeHandle";
import { searchChats } from "@/lib/chat-search";
import { appendPage, chatToAutoRestore, mergeRecents, SYNC_FLAG } from "@/lib/chat-sync";
import { loadSidebarCollapsed, saveSidebarCollapsed } from "@/lib/sidebar-pane";
import type { ConvoSummary } from "@/types/chat-history.types";
import { suggestionsFor } from "@/lib/game-suggestions";
import { shouldAutoRetry } from "@/lib/stream-recovery";
import { pollTurnResult } from "@/lib/turn-resume";
import { savePendingTurn, clearPendingTurn, loadPendingTurn } from "@/lib/pending-turn";
import { savePendingMessage, loadPendingMessage, clearPendingMessage } from "@/lib/pending-message";
import { waitLine } from "@/lib/wait-line";
import { useWakeLock } from "./useWakeLock";
import { RenameNoticeBanner } from "./RenameNoticeBanner";

const KIND_FALLBACK = "Let's talk about something else! How about a game? 🌟";

function newConversation(workspace: Workspace = "default"): Conversation {
  return {
    id: crypto.randomUUID(),
    title: "New chat",
    messages: [
      {
        id: crypto.randomUUID(),
        role: "assistant",
        text:
          workspace === "bible-teacher"
            ? "Hi! I'm Ari. Tell me the Bible story or lesson, and I'll build a game for your class. 📖"
            : "Hi! I'm your buddy. Ask me anything, or say **make me a game**! 🌟",
        createdAt: Date.now(),
      },
    ],
    // Tag the thread's surface so it lands in the right recents list
    // (PRD-BIBLE-TEACHER) — omit for the kid default to keep rows clean.
    ...(workspace === "bible-teacher" ? { workspace } : {}),
  };
}

/** Strip markdown so the read-aloud voice doesn't speak symbols. */
function plain(text: string): string {
  return text
    .replace(/[#*_`>~-]/g, " ")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Props for the chat container. `persona` selects a server persona for this
 *  surface (PRD-BIBLE-TEACHER): the /bible-teacher page passes "bible-teacher"
 *  so /api/chat can apply the teacher prompt/safety — but the server ALWAYS
 *  fail-closes it to the verified-adult session (resolvePersona), so this is a
 *  UX hint, never the access control. Omitted → the default child experience. */
export interface ChatPanelContainerProps {
  persona?: "bible-teacher";
}

export function ChatPanelContainer({ persona }: ChatPanelContainerProps = {}) {
  const { status: authStatus } = useSession();
  // This surface's workspace (PRD-BIBLE-TEACHER): the teacher surface keeps its
  // own recents list + localStorage bucket, separate from the kid default.
  const workspace: Workspace = persona === "bible-teacher" ? "bible-teacher" : "default";
  // The SURFACE is the signal (owner direction 2026-07-23): anything created on
  // /bible-teacher publishes to /bible-games — full stop, regardless of adult
  // status. Age verification gates ACCESS to the teacher surface (the relaxed
  // authoring persona, via the trial-spent age gate), NOT publishing. So the
  // publish affordance fixes the category to "Bible games" for everyone on this
  // surface; a game authored here is a Bible game by definition.
  const publishesAsBible = workspace === "bible-teacher";
  const [convos, setConvos] = useState<Conversation[]>([newConversation(workspace)]);
  const [activeId, setActiveId] = useState(convos[0]!.id);
  const [busy, setBusy] = useState(false);
  // Latest kid-safe thought summary from the model's thinking phase — shown in
  // place of the static "Thinking…" so planning feels alive (2026-07-11).
  // Server-filtered (kid-thought.ts); reset at every stream start.
  const [thinkingLine, setThinkingLine] = useState<string | null>(null);
  // Escalating wait status (owner decision 2026-07-13): while busy with no
  // model thought to show, the line rotates by elapsed time (wait-line.ts) —
  // never a frozen "Thinking…" for minutes.
  const busyStartRef = useRef(0);
  const [, setWaitTick] = useState(0);
  useEffect(() => {
    if (!busy) return;
    busyStartRef.current = Date.now();
    const t = window.setInterval(() => setWaitTick((x) => x + 1), 5_000);
    return () => window.clearInterval(t);
  }, [busy]);
  const [artifact, setArtifact] = useState<string | null>(null);
  // Desktop full-screen preview (PRD-PREVIEW-PANE): a CSS-only wrapper toggle —
  // the ArtifactFrame subtree (and its iframe) never remounts, so collapsing
  // returns to exactly the prior view. Reset whenever the panel closes.
  // Purely manual now (2026-07-15): a brief auto-expand-while-testing
  // mechanism (2026-07-14) was removed — it broke the continuity of "I
  // generated this, and here's the game" by yanking the kid into full
  // screen the instant code finished. The verify cover now shows inline in
  // the normal split view; a kid expands via the Full Screen button.
  const [expandState, setExpandState] = useState<ExpandState>({ expanded: false });
  const previewExpanded = expandState.expanded;
  const [sidebarOpen, setSidebarOpen] = useState(false); // mobile drawer; always visible on md+
  // Desktop icon-rail collapse (2026-07-17) — mobile ignores this (its drawer
  // is already collapsible via sidebarOpen). Starts expanded; the saved value
  // hydrates after mount so server/client markup matches on first paint.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  useEffect(() => {
    setSidebarCollapsed(loadSidebarCollapsed(window.localStorage));
  }, []);
  function toggleSidebarCollapsed() {
    setSidebarCollapsed((c) => {
      const next = !c;
      saveSidebarCollapsed(window.localStorage, next);
      return next;
    });
  }
  const [searchQuery, setSearchQuery] = useState(""); // sidebar chat search (title + message text)
  // Server-side history (TECH_DEBT #26): the paginated Recents index from
  // /api/chats. Chats live durably on the server keyed by account/guest
  // cookie; localStorage is just the warm cache. remoteIndex holds summaries
  // only — a chat's messages are fetched when the kid opens it.
  const [remoteIndex, setRemoteIndex] = useState<ConvoSummary[]>([]);
  const [remoteHasMore, setRemoteHasMore] = useState(false);
  // A failed fetch used to leave Recents silently empty with no way to tell
  // "you have no chats" apart from "the server didn't answer" (2026-07-17).
  const [recentsError, setRecentsError] = useState(false);
  const remoteIndexRef = useRef<ConvoSummary[]>([]);
  remoteIndexRef.current = remoteIndex;
  const remoteLoadingRef = useRef(false);
  // Set when the server stops the guest: sign-in gate (token limit), rate-limit, or pay wall.
  const [gate, setGate] = useState<{ text: string; upgrade: boolean } | null>(null);
  // Starter chips: a fresh random four per load AND per chat switch. Picked in
  // an effect — not at render — so the server HTML matches the first client
  // render (random at render = hydration mismatch).
  const [suggestions, setSuggestions] = useState<string[]>([]);
  // Pool follows the surface: a Bible teacher gets scripture starters, not
  // dinosaurs and aliens (owner report 2026-07-24).
  useEffect(() => setSuggestions(suggestionsFor(persona)), [activeId, persona]);
  const tts = useTextToSpeech();
  // Screen lock kills the socket mid-stream on phones — keep the screen awake
  // while a reply is streaming (BUG-FIX-LOG 2026-07-09).
  useWakeLock(busy);

  // Chats survive navigation (sign-in round trips, Studio links) via
  // localStorage — restore exactly ONCE on mount, persist on every change.
  // The ref makes restore one-shot: without it, StrictMode's double effect
  // pass re-reads storage AFTER the save effect has already written the fresh
  // greeting convo, clobbering the restore.
  // Idea Bag (docs/PRD-IDEA-BUTTON.md): spoken thoughts captured over the
  // preview. Same one-shot-hydrate + persist-on-change contract as chats.
  const [ideas, setIdeas] = useState<IdeaRecord[]>([]);
  // Pull-to-resize preview width (null = the 440px default via the CSS var).
  const [panelWidth, setPanelWidth] = useState<number | null>(null);
  // First-run coach state (docs/PRD-IDEA-BUTTON.md §coach): intro once, one
  // wiggle-only re-nudge if the feature stays unused, then silence forever.
  const [coachStore, setCoachStore] = useState<CoachStore>(defaultCoachStore());

  // Cross-browser chat-history bug (2026-07-16): "I lose chat though I log
  // into the same account... tied to the browser rather than the account."
  // True: a fresh browser has no local cache, so the main view defaulted to
  // a blank "New chat" even when the SAME account's real history existed
  // server-side, one click away in the sidebar. Tracked here so the
  // server-history bootstrap below knows whether it's safe to auto-restore
  // (never override a device's OWN existing local chats).
  const hadLocalChatsRef = useRef(false);
  const hydratedFromStore = useRef(false);
  useEffect(() => {
    if (hydratedFromStore.current) return;
    hydratedFromStore.current = true;
    const saved = loadChats(window.localStorage, workspace);
    if (saved) {
      setConvos(saved.convos);
      setActiveId(saved.activeId);
      hadLocalChatsRef.current = saved.convos.length > 0;
    }
    setIdeas(loadIdeas(window.localStorage));
    setCoachStore(loadCoach(window.localStorage));
    const w = loadPanelWidth(window.localStorage);
    if (w) setPanelWidth(clampPanelWidth(w, window.innerWidth));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (hydratedFromStore.current) saveChats(window.localStorage, convos, activeId, workspace);
  }, [convos, activeId]);

  // Auth-interruption recovery (BUG-FIX-LOG 2026-07-14): a sign-in wall mid-turn
  // saved the kid's message (see the 401/`gate` handling in runStream below);
  // once signed back in, resend it once instead of leaving it lost. A brief
  // note makes the auto-resend visible rather than a silent surprise. Only
  // latches once a matching pending message is actually found+consumed, so an
  // early check racing activeId's restore (unlikely — that's a synchronous
  // localStorage read, this is behind an async session fetch) still gets a
  // second chance on the next activeId change instead of giving up for good.
  const resumedPendingMessageRef = useRef(false);
  useEffect(() => {
    if (authStatus !== "authenticated" || resumedPendingMessageRef.current) return;
    const pending = loadPendingMessage(window.localStorage);
    if (!pending || pending.convoId !== activeId) return;
    resumedPendingMessageRef.current = true;
    clearPendingMessage(window.localStorage);
    patchActive((c) => ({
      ...c,
      messages: [
        ...c.messages,
        { id: crypto.randomUUID(), role: "assistant", text: "Welcome back! Sending your message now…", createdAt: Date.now() },
      ],
    }));
    void handleSend(pending.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authStatus, activeId]);

  /** Fetch the next page of the server Recents index (30/page). Reentrant-safe.
   *  Returns the fetched page (not the accumulated `remoteIndex` state, which
   *  a caller right after `await` would otherwise see stale/unset) so the
   *  bootstrap below can decide on an auto-restore without a second round trip. */
  async function loadMoreRemote(reset = false): Promise<ConvoSummary[] | undefined> {
    if (remoteLoadingRef.current) return undefined;
    remoteLoadingRef.current = true;
    try {
      const cursor = !reset ? remoteIndexRef.current.at(-1) : undefined;
      // Surface-scoped recents (PRD-BIBLE-TEACHER): only this workspace's chats.
      const params = new URLSearchParams({ workspace });
      if (cursor) { params.set("before", String(cursor.updatedAt)); params.set("beforeId", cursor.id); }
      const res = await fetch(`/api/chats?${params.toString()}`, { cache: "no-store" });
      if (!res.ok) {
        setRecentsError(true);
        return undefined;
      }
      const { chats } = (await res.json()) as { chats: ConvoSummary[] };
      setRecentsError(false);
      setRemoteHasMore(chats.length >= 30);
      setRemoteIndex((prev) => (reset ? chats : appendPage(prev, chats)));
      return chats;
    } catch {
      /* offline — the local cache still works; the retry row asks again */
      setRecentsError(true);
      return undefined;
    } finally {
      remoteLoadingRef.current = false;
    }
  }

  // Server-history bootstrap, once per mount: (1) one-time migration of the
  // device's pre-existing chats to the account/guest identity, then (2) the
  // first page of the server index. Signed-out→signed-in transitions remount
  // the app via the sign-in round trip, so this also covers "first sign-in".
  const syncedRef = useRef(false);
  useEffect(() => {
    if (syncedRef.current) return;
    syncedRef.current = true;
    const bootstrap = async () => {
      // Tab-close recovery: an in-flight turn from a previous visit? Collect
      // its finished reply from the server into the waiting bubble — the
      // reply belongs in the chat whenever the kid comes back (owner
      // decision 2026-07-13). Quick poll only; `running` turns are stale by
      // now (the stream died with the tab) so one miss is final.
      try {
        const pending = loadPendingTurn(window.localStorage);
        if (pending) {
          clearPendingTurn(window.localStorage);
          const resumed = await pollTurnResult(pending.replyId, { maxMs: 6_000, intervalMs: 2_000 });
          if (resumed) {
            console.log(`[chat] ↻ recovered a finished reply from a previous visit`);
            setConvos((list) => {
              const next = list.map((c) =>
                c.id !== pending.convoId
                  ? c
                  : {
                      ...c,
                      messages: c.messages.map((m) =>
                        m.id === pending.replyId
                          ? { ...m, text: resumed.text, artifactHtml: resumed.artifactHtml ?? undefined }
                          : m,
                      ),
                    },
              );
              const convo = next.find((c) => c.id === pending.convoId);
              if (convo) {
                // Fire-and-forget: the recovered turn is now part of durable history too.
                void fetch(`/api/chats/${encodeURIComponent(convo.id)}`, {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ convo }),
                }).catch((err) => {
                  // Breadcrumb only (2026-07-17) — client-side, no user-facing
                  // change. This exact failure class ("I lose chat across
                  // browsers") is what this recovery path exists to prevent.
                  console.warn("[chat] recovered-turn persist failed", err);
                });
              }
              return next;
            });
          }
        }
      } catch {
        /* recovery is best-effort — never block the app load */
      }
      try {
        const saved = loadChats(window.localStorage, workspace);
        if (saved?.convos.length && !window.localStorage.getItem(SYNC_FLAG)) {
          const res = await fetch("/api/chats", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ convos: saved.convos }),
          });
          // 401 = brand-new visitor with no identity yet — retry after their
          // first message mints the guest cookie (flag stays unset).
          if (res.ok) window.localStorage.setItem(SYNC_FLAG, "1");
        }
      } catch {
        /* offline migration attempt — flag stays unset, retried next visit */
      }
      const chats = await loadMoreRemote(true);
      // Cross-browser chat-history bug (2026-07-16, see hadLocalChatsRef
      // above): this device had NOTHING locally, but the account/guest
      // identity already has real history server-side — open the most
      // recent one instead of leaving the blank default greeting active.
      // Replaces (not appends) — that greeting was never a real chat, just
      // this render's placeholder before the restore landed.
      const restoreId = chatToAutoRestore(hadLocalChatsRef.current, chats ?? []);
      if (restoreId) {
        try {
          const res = await fetch(`/api/chats/${encodeURIComponent(restoreId)}`, { cache: "no-store" });
          if (res.ok) {
            const { convo } = (await res.json()) as { convo: Conversation };
            setConvos([convo]);
            setActiveId(convo.id);
          }
        } catch {
          /* offline — the blank greeting stays; sidebar still has the index */
        }
      }
    };
    void bootstrap();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot bootstrap
  }, []);

  // Write-through: when a turn finishes (busy true→false), persist the active
  // conversation server-side. Not per-delta — a game streams ~200KB and we
  // don't want a PUT per token. Fire-and-forget: a failed sync costs nothing
  // (localStorage still has it; the next finished turn re-syncs the whole convo).
  const prevBusyRef = useRef(false);
  useEffect(() => {
    const wasBusy = prevBusyRef.current;
    prevBusyRef.current = busy;
    if (!wasBusy || busy) return; // only on the finished-turn transition
    const c = convos.find((x) => x.id === activeId);
    if (!c || c.messages.length < 2) return; // greeting-only chat — nothing to keep
    fetch(`/api/chats/${encodeURIComponent(c.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ convo: c }),
    })
      .then((res) => {
        if (!res.ok) {
          console.warn(`[chat] write-through persist failed: ${res.status}`);
          return;
        }
        setRemoteIndex((prev) => [
          { id: c.id, title: c.title, updatedAt: Date.now() },
          ...prev.filter((r) => r.id !== c.id),
        ]);
      })
      .catch((err) => {
        // Breadcrumb only (2026-07-17) — local cache still covers it until
        // the next finished turn re-syncs; this exact failure class ("I lose
        // chat across browsers") is what this write-through path guards.
        console.warn("[chat] write-through persist failed", err);
      });
  }, [busy, convos, activeId]);
  useEffect(() => {
    if (hydratedFromStore.current) saveIdeas(window.localStorage, ideas);
  }, [ideas]);
  useEffect(() => {
    if (hydratedFromStore.current) saveCoach(window.localStorage, coachStore);
  }, [coachStore]);
  const baggedIdeas = useMemo(() => baggedFor(ideas, activeId), [ideas, activeId]);

  // Count game-preview opens toward the re-nudge: each time the panel goes
  // from closed to open post-intro while the feature is still unused.
  const artifactWasOpenRef = useRef(false);
  useEffect(() => {
    const open = artifact !== null;
    const justOpened = open && !artifactWasOpenRef.current;
    artifactWasOpenRef.current = open;
    if (!justOpened) return;
    setCoachStore((s) =>
      s.seen && !s.everCaptured && !s.renudged ? { ...s, gamesSinceCoach: s.gamesSinceCoach + 1 } : s,
    );
  }, [artifact]);

  const active = convos.find((c) => c.id === activeId) ?? convos[0]!;

  // ── Idea Queue (docs/PRD-IDEA-QUEUE.md) ────────────────────────────────
  // Ideas typed while Ari is building. They live on the conversation (so
  // chat-store + the write-through persist them), drain one at a time, and
  // FREEZE after a stop/failure rather than stacking onto a broken game.
  const queuedIdeas = active.queuedIdeas ?? [];
  const [queuePaused, setQueuePaused] = useState(false);
  // Only ever set false by an explicit kid action (a send, or "keep going") —
  // opening/restoring a chat that still has a line always asks first, so
  // nothing is generated while nobody is watching.
  useEffect(() => setQueuePaused(true), [activeId]);
  function patchQueue(fn: (q: QueuedIdea[]) => QueuedIdea[]) {
    patchActive((c) => ({ ...c, queuedIdeas: fn(c.queuedIdeas ?? []) }));
  }

  // Sidebar list = local chats (full-text searched) + server-only chats not on
  // this device (title-searched; their messages load when opened).
  const recents = useMemo(
    () =>
      mergeRecents(
        searchChats(convos, searchQuery).map((c) => ({ id: c.id, title: c.title })),
        remoteIndex,
        searchQuery,
      ),
    [convos, searchQuery, remoteIndex],
  );

  // Scroll model = Gemini's "anchor to the prompt" (2026-07-09, replaces
  // stick-to-bottom): on send, the child's request pins to the TOP of the view
  // and the reply streams in below it — the screen never chases a long code
  // stream. During streaming we deliberately do nothing; the kid scrolls freely.
  // Switching/opening a chat still jumps to the latest messages.
  const scrollRef = useRef<HTMLDivElement>(null);
  const anchorIdRef = useRef<string | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    const anchorId = anchorIdRef.current;
    if (!el || !anchorId) return;
    const target = document.getElementById(`msg-${anchorId}`);
    if (!target) return;
    // Right after send there may not be enough content below to put the request
    // at the top — the browser clamps the scroll. Keep the anchor active and
    // keep pulling on every stream update until the request reaches the top
    // (Gemini's slide-up), then let go. A manual scroll cancels it (see below).
    const desired = target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 12;
    el.scrollTop = desired;
    if (el.scrollTop >= desired - 1) anchorIdRef.current = null;
  }, [active.messages]);
  // The kid taking over the scrollbar always wins over the anchor.
  function handleManualScroll() {
    anchorIdRef.current = null;
  }
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeId]);

  function patchActive(fn: (c: Conversation) => Conversation) {
    setConvos((list) => list.map((c) => (c.id === activeId ? fn(c) : c)));
  }

  const abortRef = useRef<AbortController | null>(null);
  const manualStopRef = useRef(false);

  // Session memory for uploaded pictures (per conversation): follow-up messages
  // and regenerate re-send the latest picture so the model keeps "seeing" it —
  // Gemini-app behaviour for the upload→iterate flow. Deliberately a ref, NOT
  // persisted: images would blow the localStorage quota (TECH_DEBT #26 lifts
  // this with server-side history). Lost on reload — the honest client-only limit.
  const sessionImagesRef = useRef(new Map<string, { mimeType: string; data: string }>());

  function handleNewChat() {
    tts.stop();
    const c = newConversation(workspace);
    setConvos((list) => [c, ...list]);
    setActiveId(c.id);
    setArtifact(null);
    setExpandState({ expanded: false });
    setSearchQuery("");
    setSidebarOpen(false);
  }

  // PRD-RESILIENT-GENERATION §11 — the child answered the "is this a whole new
  // game?" prompt. Nothing was rebuilt yet, so both choices are non-destructive:
  // "New game" opens a fresh chat (this one stays exactly as it is, still
  // playable), "Change this one" rebuilds the new game in place, here.
  const pendingNewChatSend = useRef<{ convoId: string; text: string } | null>(null);

  function answerNewGamePrompt(replyId: string, requestText: string, choice: "new-chat" | "rebuild") {
    if (busy) return;
    // Clear the prompt so the buttons don't linger, and it can't re-show on reload.
    patchActive((c) => ({
      ...c,
      messages: c.messages.map((m) => (m.id === replyId ? { ...m, newGamePrompt: false } : m)),
    }));
    if (!requestText.trim()) return;
    if (choice === "rebuild") {
      void handleSend(requestText, undefined, { forceRebuild: true });
      return;
    }
    // Fresh chat. handleSend targets the ACTIVE conversation, which only becomes
    // this new one after the state below commits — so queue the send and let the
    // effect fire it once the switch has rendered (never against the old chat).
    tts.stop();
    const c = newConversation(workspace);
    setConvos((list) => [c, ...list]);
    setActiveId(c.id);
    setArtifact(null);
    setExpandState({ expanded: false });
    setSidebarOpen(false);
    pendingNewChatSend.current = { convoId: c.id, text: requestText };
  }

  useEffect(() => {
    const pending = pendingNewChatSend.current;
    if (pending && pending.convoId === activeId) {
      pendingNewChatSend.current = null;
      void handleSend(pending.text);
    }
    // handleSend reads the freshly-active (empty) conversation as history — a
    // clean first build in the new chat. eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  function handleSelect(id: string) {
    tts.stop();
    setArtifact(null);
    setExpandState({ expanded: false });
    setSidebarOpen(false);
    if (convos.some((c) => c.id === id)) {
      setActiveId(id);
      return;
    }
    // Server-only chat (older than this device's cache): fetch its messages,
    // then open it. On failure the kid simply stays on the current chat.
    void (async () => {
      try {
        const res = await fetch(`/api/chats/${encodeURIComponent(id)}`, { cache: "no-store" });
        if (!res.ok) return;
        const { convo } = (await res.json()) as { convo: Conversation };
        setConvos((list) => (list.some((c) => c.id === convo.id) ? list : [...list, convo]));
        setActiveId(convo.id);
      } catch {
        /* offline — server-only chats need a connection */
      }
    })();
  }

  /** Resolves immediately if the page is visible, else on the next return to
   *  the foreground — retrying while the screen is locked would just drop again. */
  function whenVisible(): Promise<void> {
    if (typeof document === "undefined" || !document.hidden) return Promise.resolve();
    return new Promise((resolve) => {
      const onVisibility = () => {
        if (document.hidden) return;
        document.removeEventListener("visibilitychange", onVisibility);
        resolve();
      };
      document.addEventListener("visibilitychange", onVisibility);
    });
  }

  // Core streaming routine, shared by send + regenerate. Fills the message `replyId`.
  // `attempt` counts silent auto-retries after mid-stream drops (screen lock /
  // app switch) — the kid only sees a message once retries are exhausted.
  async function runStream(
    text: string,
    history: ChatMessage[],
    replyId: string,
    attempt = 0,
    image?: { mimeType: string; data: string },
    // Fired ONLY on the `done` event — the Idea Bag empties through this, so a
    // dropped/blocked/errored stream can never eat a kid's ideas.
    onSuccess?: () => void,
    // "Continue from here" (chat-rewind.ts): captured once at send time so a
    // silent auto-retry of THIS turn still targets the same pinned version,
    // even though the conversation's pin is cleared right after sending.
    activeGameMessageId?: string,
    // "Change this one ✏️" after a new-game prompt (PRD §11): rebuild the new
    // game in place, skipping new-game detection so it can't ask again.
    forceRebuild = false,
    // "🔄 Different one" (PRD-INSTANT-ALTERNATE): regenerate led by the fallback
    // model, so the kid gets a genuinely different take.
    differentVersion = false,
  ) {
    const setReply = (t: string, artifactHtml?: string, newGamePrompt?: boolean) =>
      patchActive((c) => ({
        ...c,
        messages: c.messages.map((m) =>
          m.id === replyId ? { ...m, text: t, artifactHtml, ...(newGamePrompt ? { newGamePrompt: true } : {}) } : m,
        ),
      }));

    // Phase-aware stall guard: builder turns THINK silently before the first
    // token (bounded budget, see builder-mode.ts) — give the start more rope,
    // then expect steady deltas once streaming has begun.
    const FIRST_TOKEN_STALL_MS = 90_000;
    const STALL_MS = 30_000;
    const controller = new AbortController();
    abortRef.current = controller;
    manualStopRef.current = false;
    const startedAt = Date.now();
    let firstTokenAt = 0;
    let stall = setTimeout(() => controller.abort(), FIRST_TOKEN_STALL_MS);
    const bump = () => {
      clearTimeout(stall);
      stall = setTimeout(() => controller.abort(), firstTokenAt ? STALL_MS : FIRST_TOKEN_STALL_MS);
    };
    let finalized = false;
    let willRetry = false;
    // Idea Queue: only a CLEAN finish (`done`, or a reply resumed from the
    // server) releases the next queued idea. Stops, gates, retractions and
    // errors freeze the line and let the kid decide — `finalized` is too
    // broad here, it's true for blocked/errored turns too.
    let turnOk = false;
    let acc = "";
    setBusy(true);
    setThinkingLine(null);
    // Tab-close recovery bookmark: if the kid leaves entirely mid-generation,
    // the next app load finds this and collects the finished reply from the
    // server (turn_results) into the waiting bubble. Cleared on a normal finish.
    if (attempt === 0) savePendingTurn(window.localStorage, { replyId, convoId: activeId, startedAt: Date.now() });
    console.log(`[chat] ▶ sending: "${text.slice(0, 60)}"`);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // replyId: the server keeps this turn's finished result under it, so a
        // dropped/stalled stream can be RESUMED (polled) instead of re-generated.
        body: JSON.stringify({
          message: text,
          history,
          replyId,
          ...(image ? { image } : {}),
          ...(activeGameMessageId ? { activeGameMessageId } : {}),
          ...(forceRebuild ? { forceRebuild: true } : {}),
          ...(differentVersion ? { differentVersion: true } : {}),
          ...(persona ? { persona } : {}),
        }),
        signal: controller.signal,
      });
      // Fail loud, never hang: a non-streaming response (401 auth gate, 4xx/5xx, or a body-less
      // reply from a proxy) must surface here instead of stalling on getReader() until the 30s
      // stall timeout. See BUG-FIX-LOG: "silent hang on non-streaming response".
      if (!res.ok || !res.body) {
        // Gate statuses (silent-hang prevention: blocks travel as HTTP statuses).
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        if (res.status === 401) {
          setReply(body.message ?? "Please sign in to continue using Ari ✨");
          setGate({ text: body.message ?? "Please sign in to continue using Ari ✨", upgrade: false });
          // Auth interruption (BUG-FIX-LOG 2026-07-14): remember what the kid
          // was sending so it can auto-resend after sign-in instead of being
          // silently lost (retyping after the platform redirect read as "the
          // chat died"). Text-only — scoped to the common case.
          if (!image) savePendingMessage(window.localStorage, { text, convoId: activeId, savedAt: Date.now() });
        } else if (res.status === 402) {
          setReply(body.message ?? "Upgrade to keep chatting! ⭐");
          setGate({ text: body.message ?? "Upgrade to keep chatting! ⭐", upgrade: true });
        } else if (res.status === 429) {
          setReply(body.message ?? "Whoa, slow down! 🐢 Take a short break and try again.");
        } else if (res.status === 400 && body.message) {
          setReply(body.message); // e.g. rejected picture — server says what to do next
        } else {
          setReply("Oops! Something went wrong. Let's try again.");
        }
        finalized = true;
        console.error(`[chat] ✖ non-OK response status=${res.status}`);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bump();
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const ev = JSON.parse(line) as { type: string; text?: string; artifactHtml?: string | null; newGamePrompt?: boolean };
          if (ev.type === "thinking") {
            if (ev.text) setThinkingLine(ev.text);
          } else if (ev.type === "delta") {
            if (!firstTokenAt) { firstTokenAt = Date.now(); console.log(`[chat] first token @${firstTokenAt - startedAt}ms`); }
            acc += ev.text ?? "";
            setReply(streamingDisplayText(acc));
          } else if (ev.type === "restart") {
            // A model died mid-answer and a fallback is answering FRESH
            // (2026-07-13): the partial code was only a "working" signal —
            // wipe the chat bubble alone (preview/other UI untouched) and
            // relay the new model's thoughts + code from scratch.
            acc = "";
            firstTokenAt = 0; // new model thinks first — back to the generous first-token stall budget
            setReply("");
            setThinkingLine(null);
            console.warn(`[chat] ↻ fallback model restart @${Date.now() - startedAt}ms — partial reply cleared`);
          } else if (ev.type === "done") {
            setReply(ev.text ?? acc, ev.artifactHtml ?? undefined, ev.newGamePrompt);
            setArtifact((a) => nextArtifact({ type: "done", artifactHtml: ev.artifactHtml }, a));
            setBusy(false);
            finalized = true;
            turnOk = true;
            onSuccess?.();
            console.log(`[chat] ✓ shown @${Date.now() - startedAt}ms artifact=${ev.artifactHtml ? "yes" : "no"}`);
          } else if (ev.type === "retract") {
            setReply(ev.text ?? KIND_FALLBACK);
            setArtifact((a) => nextArtifact({ type: "retract" }, a)); // safety: always blank
            finalized = true;
            console.warn(`[chat] retracted by safety monitor`);
          } else if (ev.type === "blocked") {
            setReply(ev.text ?? KIND_FALLBACK);
            finalized = true;
            console.warn(`[chat] blocked by safety monitor`);
          } else if (ev.type === "gate") {
            setReply(ev.text ?? "Sign in to keep chatting. ✨");
            setGate({ text: ev.text ?? "Sign in to keep chatting!", upgrade: false });
            // Same auto-resend recovery as the top-level 401 above — this is
            // the mid-stream flavor of the same sign-in wall.
            if (!image) savePendingMessage(window.localStorage, { text, convoId: activeId, savedAt: Date.now() });
            finalized = true;
            console.warn(`[chat] gated — sign-in required`);
          } else if (ev.type === "rate_limited") {
            setReply(ev.text ?? "Slow down a little! 🐢");
            setGate({ text: ev.text ?? "Too many messages — come back tomorrow or sign in.", upgrade: false });
            finalized = true;
            console.warn(`[chat] rate-limited`);
          } else if (ev.type === "paywall") {
            setReply(ev.text ?? "Upgrade to keep chatting. 💳");
            setGate({ text: ev.text ?? "You've hit the free limit too many times.", upgrade: true });
            finalized = true;
            console.warn(`[chat] paywall — strikes exhausted`);
          } else if (ev.type === "error") {
            setReply(ev.text ?? "Oops! Let's try again.");
            finalized = true;
          }
        }
      }
    } catch (err) {
      const aborted = (err as Error)?.name === "AbortError";
      if (manualStopRef.current) {
        setReply(streamingDisplayText(acc) || "⏹ Stopped."); // user pressed Stop — keep whatever streamed
        console.warn(`[chat] stopped by user after ${Date.now() - startedAt}ms`);
      } else if (finalized) {
        console.warn(`[chat] post-finalize stream drop (ignored) after ${Date.now() - startedAt}ms`);
      } else if (shouldAutoRetry({ manualStop: manualStopRef.current, finalized, attempt })) {
        // Retry by ourselves (BUG-FIX-LOG 2026-07-09) — "Ask me again" put the
        // recovery work on the kid, and screen-lock drops happen constantly.
        willRetry = true;
        console.warn(`[chat] ↻ stream ${aborted ? "stalled" : "dropped"} after ${Date.now() - startedAt}ms — auto-retry ${attempt + 1}`);
        setReply(`${acc ? `${streamingDisplayText(acc)}\n\n---\n` : ""}📶 Reconnecting… hang tight!`);
      } else {
        console.error(`[chat] ✖ ${aborted ? "STALLED (no tokens 30s)" : "stream error"} after ${Date.now() - startedAt}ms (retries exhausted)`, err);
        // NEVER discard what already streamed (BUG-FIX-LOG 2026-07-07: phones
        // drop the socket on screen-lock/app-switch mid-generation — the kid
        // watched the code arrive, then "Oops" ATE it). Keep the partial reply
        // and append a friendly next step instead.
        const note = aborted
          ? "\n\n---\n😅 That took too long — the model is busy. Ask me again!"
          : "\n\n---\n📶 The connection keeps hiccuping — I tried a few times. Ask me again and I'll redo it!";
        setReply(acc ? streamingDisplayText(acc) + note : note.replace(/^\n+---\n/, ""));
      }
    } finally {
      clearTimeout(stall);
      abortRef.current = null;
      // A finalized turn (or a manual stop) has nothing left to recover.
      // Exhausted retries deliberately KEEP the bookmark — a later reload can
      // still collect the reply the server finished on its own.
      if (finalized || manualStopRef.current) clearPendingTurn(window.localStorage);
      if (!willRetry) {
        setBusy(false); // stay "busy" across a retry — no flicker, Stop still works
        setQueuePaused(!turnOk); // anything but a clean finish → the queue asks first
      }
      console.log(`[chat] finished; total ${Date.now() - startedAt}ms${willRetry ? " (retrying)" : ""}`);
    }

    if (willRetry) {
      await whenVisible(); // screen locked? wait for the kid to come back first
      await new Promise((r) => setTimeout(r, 800));
      if (manualStopRef.current) {
        setReply(streamingDisplayText(acc) || "⏹ Stopped.");
        setBusy(false);
        setQueuePaused(true);
        return;
      }
      // Resume before re-generating (TECH_DEBT #23 shipped): the server kept
      // generating while we were detached — under heavy load the reply is
      // usually FINISHED (or still cooking: `running` gets minutes of free
      // patience). Only a genuine server-side failure re-generates (paid).
      // Stop-aware + dead-server fail-fast (BUG-FIX-LOG 2026-07-18): the kid's
      // ⏹ must break this wait, and a server that never answers gets ~20s of
      // patience, not 4 minutes of a frozen "Reconnecting…" banner.
      const resumed = await pollTurnResult(replyId, { shouldStop: () => manualStopRef.current });
      if (manualStopRef.current) {
        setReply(streamingDisplayText(acc) || "⏹ Stopped.");
        setBusy(false);
        setQueuePaused(true);
        return;
      }
      if (resumed) {
        console.log(`[chat] ↻ resumed the finished reply from the server (no re-generation)`);
        setReply(resumed.text, resumed.artifactHtml ?? undefined);
        setArtifact((a) => nextArtifact({ type: "done", artifactHtml: resumed.artifactHtml }, a));
        clearPendingTurn(window.localStorage);
        setBusy(false);
        setQueuePaused(false); // the reply landed intact — the line may drain
        onSuccess?.();
        return;
      }
      await runStream(text, history, replyId, attempt + 1, image, onSuccess, activeGameMessageId);
    }
  }

  /** What the composer calls. While Ari is building, a send doesn't die (the
   *  old `disabled={busy}`) and doesn't interrupt — it joins the line
   *  (docs/PRD-IDEA-QUEUE.md). Programmatic callers keep using handleSend. */
  function handleComposerSend(text: string, attachment?: Attachment) {
    if (busy) {
      // The composer refuses (with a reason) before it gets here when the line
      // is full or a file is attached; this is the belt-and-braces half.
      if (!attachment && canQueue(queuedIdeas)) patchQueue((q) => enqueueIdea(q, text));
      return;
    }
    void handleSend(text, attachment);
  }

  async function handleSend(
    text: string,
    attachment?: Attachment,
    opts?: { fromIdeaBag?: boolean; onSuccess?: (childId: string) => void; forceRebuild?: boolean },
  ) {
    // A turn the kid (or the drain) deliberately started — the line is rolling
    // again, so drop any "still want these?" hold from an earlier failure.
    setQueuePaused(false);
    const history = active.messages;
    // "Continue from here" pin (chat-rewind.ts): captured now, sent with THIS
    // turn only, then cleared below — once this reply lands it's the newest
    // message again, so ordinary "last game wins" behavior resumes on its own.
    const activeGameMessageId = active.activeGameMessageId;
    const replyId = crypto.randomUUID();
    const displayText = text || (attachment ? "" : "");
    // What the model receives: text files fold their contents into the prompt;
    // pictures travel as a real image part (base64) NEXT to the prompt — and are
    // NOT stored in history (localStorage quota; single-turn context by design).
    const isImage = attachment?.kind === "image";
    const apiMessage =
      attachment && attachment.kind === "text"
        ? `The child attached a file named "${attachment.name}". Its contents:\n\`\`\`\n${attachment.content}\n\`\`\`\n\n${text || "Please take a look at this file."}`
        : isImage
          ? text || "Please take a look at this picture."
          : text;
    // A fresh upload replaces the conversation's remembered picture; otherwise
    // keep sending the one from earlier this session (if any).
    const image = isImage
      ? { mimeType: attachment.mimeType, data: attachment.data }
      : sessionImagesRef.current.get(activeId);
    if (isImage && image) sessionImagesRef.current.set(activeId, image);
    const childId = crypto.randomUUID();
    anchorIdRef.current = childId; // pin the request to the top of the view
    patchActive((c) => ({
      ...c,
      title: c.title === "New chat" ? (text || attachment?.name || "New chat").slice(0, 40) : c.title,
      activeGameMessageId: undefined, // consumed by this turn — see runStream below
      messages: [
        ...c.messages,
        {
          id: childId,
          role: "child",
          text: displayText,
          attachmentName: attachment?.name,
          ...(opts?.fromIdeaBag ? { fromIdeaBag: true } : {}),
          createdAt: Date.now(),
        },
        {
          id: replyId, role: "assistant", text: "", createdAt: Date.now(),
          ...(activeGameMessageId ? { basedOnMessageId: activeGameMessageId } : {}),
        },
      ],
    }));
    // `busy` only flips on the next render, so two effects flushing together
    // (a queued ✨ bundle and the Idea Queue drain) would both still read
    // busy=false and fire two turns. This ref closes that gap synchronously.
    sendingRef.current = true;
    try {
      await runStream(
        apiMessage, history, replyId, 0, image,
        opts?.onSuccess && (() => opts.onSuccess!(childId)),
        activeGameMessageId,
        opts?.forceRebuild ?? false,
      );
    } finally {
      sendingRef.current = false;
    }
  }

  const sendingRef = useRef(false);

  // Drain the Idea Queue: one idea per clean finish, oldest first. The idea is
  // removed from the line BEFORE it's sent, so a re-render can never fire the
  // same one twice; `hold` (after a stop/failure) waits for the kid's "keep
  // going" instead — nothing generates unattended on a half-built game.
  useEffect(() => {
    if (sendingRef.current) return;
    const action = queueSendAction({ hasQueued: queuedIdeas.length > 0, busy, paused: queuePaused });
    if (action !== "send") return;
    const { next, rest } = takeNextIdea(queuedIdeas);
    if (!next) return;
    patchQueue(() => rest);
    void handleSend(next.text);
    // Reads fresh state from the render closure each pass (same contract as
    // the ✨ queue effect above). eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, queuePaused, queuedIdeas]);

  // ✨ Make my game better! — the whole bag becomes ONE visible chat message
  // (no hidden side-channel); ideas flip to `sent` only when the generation
  // finishes, so failures keep every thought safely bagged.
  //
  // Queue-governed ✨ (owner asks 2026-07-21, BUG-FIX-LOG). EVERY tap just sets
  // this flag — the effect below decides send/wait/clear via `ideaQueueAction`.
  // Why not send synchronously: (a) a tap while Ari builds must QUEUE, not die
  // ("disabled={busy}" made it dead); (b) the mic bar commits a just-spoken
  // idea (setIdeas) and taps ✨ in the SAME event — a synchronous read would
  // see the pre-commit empty bag and send nothing ("first tap did nothing,
  // second worked"). Deferring to an effect lets React's batched commit land
  // the idea first, so the send always sees the complete bag.
  const [queuedMakeBetter, setQueuedMakeBetter] = useState(false);

  function handleMakeBetter() {
    setQueuedMakeBetter(true);
  }

  // The actual compose-and-send — reads the freshly-committed bag.
  async function sendMakeBetter() {
    const convoId = activeId;
    const bundle = composeIdeaBundle(baggedFor(ideas, convoId).map((i) => i.text));
    if (!bundle) return;
    setExpandState({ expanded: false }); // watch the send land in chat (desktop split view)
    // Mobile: the panel covers the whole screen — flip to the chat so the kid
    // SEES the bundle post; the updated game re-opens the panel via `done`.
    if (window.matchMedia("(max-width: 767px)").matches) setArtifact(null);
    await handleSend(bundle, undefined, {
      fromIdeaBag: true,
      onSuccess: (childId) => setIdeas((list) => markSent(list, convoId, childId)),
    });
  }

  // Resolve a queued ✨: send once Ari is idle WITH ideas bagged (a just-spoken
  // idea has committed by now — the race fix), keep waiting while a turn is
  // still building, and self-clear a queue that has no ideas so it can never
  // fire empty. When it sends, busy flips true and the action drops to "wait" —
  // no re-fire loop; onSuccess empties the bag on `done` alone.
  useEffect(() => {
    const action = ideaQueueAction({ queued: queuedMakeBetter, busy, hasBaggedIdeas: baggedIdeas.length > 0 });
    if (action === "send") {
      setQueuedMakeBetter(false);
      void sendMakeBetter();
    } else if (action === "clear") {
      setQueuedMakeBetter(false);
    }
    // sendMakeBetter reads fresh state from the render closure each pass.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, queuedMakeBetter, baggedIdeas]);

  function handleStop() {
    manualStopRef.current = true;
    abortRef.current?.abort();
  }

  // Regenerate: re-run the last user prompt, replacing the last answer.
  // `differentVersion` ("🔄 Different one") leads the chain with the fallback
  // model so the redo is a genuinely different take, not the same primary
  // re-rolled. Param-less wrappers below keep the MessageItem onClick handlers
  // from passing a truthy MouseEvent into the flag.
  function handleRegenerate() { void regenerate(false); }
  function handleDifferentOne() { void regenerate(true); }

  async function regenerate(differentVersion: boolean) {
    if (busy) return;
    const msgs = active.messages;
    let idx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]!.role === "child") { idx = i; break; }
    if (idx === -1) return;
    const userText = msgs[idx]!.text;
    const history = msgs.slice(0, idx);
    const replyId = crypto.randomUUID();
    // The reply being redone may itself have been generated against a
    // "Continue from here" pin (chat-rewind.ts) rather than whatever's newest
    // in `history` — carry it forward so the redo targets the SAME version,
    // not whatever the sliced history now considers newest.
    const basedOnMessageId = msgs[idx + 1]?.basedOnMessageId;
    // Keep the old game on screen and playable until the redo lands
    // (PRD-PREVIEW-PANE §2 — regenerate used to blank the panel here).
    setArtifact((a) => nextArtifact({ type: "regenerate" }, a));
    anchorIdRef.current = msgs[idx]!.id; // re-pin the request being regenerated
    patchActive((c) => ({
      ...c,
      messages: [
        ...c.messages.slice(0, idx + 1),
        {
          id: replyId, role: "assistant", text: "", createdAt: Date.now(),
          ...(basedOnMessageId ? { basedOnMessageId } : {}),
        },
      ],
    }));
    await runStream(userText, history, replyId, 0, sessionImagesRef.current.get(activeId), undefined, basedOnMessageId, false, differentVersion);
  }

  // "Continue from here" (an earlier game was better): pins this message as
  // the one the NEXT edit turn builds on (Conversation.activeGameMessageId,
  // consumed and cleared by handleSend) instead of whatever's newest — see
  // chat-rewind.ts. Non-destructive: nothing is deleted or reordered, the
  // regressed later messages stay right where they are in the thread.
  function handleContinueFromHere(messageId: string) {
    if (busy) return;
    const target = active.messages.find((m) => m.id === messageId);
    if (!target) return;
    tts.stop();
    setArtifact(target.artifactHtml ?? null);
    patchActive((c) => ({ ...c, activeGameMessageId: messageId }));
  }

  // Guests may chat up to the free-token trial (server-enforced); the sign-in
  // wall arrives as an HTTP 401 → LoginGate. No upfront block anymore.
  return (
    <div className="flex h-full w-full bg-white text-neutral-900">
      <Sidebar
        recents={recents}
        activeId={activeId}
        isOpen={sidebarOpen}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onClose={() => setSidebarOpen(false)}
        onNewChat={handleNewChat}
        onSelect={handleSelect}
        hasMore={remoteHasMore}
        onEndReached={() => void loadMoreRemote()}
        recentsError={recentsError}
        onRetryRecents={() => void loadMoreRemote(remoteIndex.length === 0)}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={toggleSidebarCollapsed}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar — hamburger opens the drawer; hidden on md+ where the sidebar is static. */}
        <div className="flex items-center gap-2 border-b border-neutral-200 px-3 py-2 md:hidden">
          <button
            aria-label="Open menu"
            onClick={() => setSidebarOpen(true)}
            className="rounded-lg p-2 text-neutral-600 hover:bg-neutral-100"
          >
            ☰
          </button>
          <span className="text-base font-semibold text-neutral-700">✨ Ari</span>
        </div>
        <div className="px-4 pt-3">
          <RenameNoticeBanner />
        </div>
        <div
          ref={scrollRef}
          onWheel={handleManualScroll}
          onTouchMove={handleManualScroll}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8">
            {active.messages.map((m, i) => (
              <div key={m.id} id={`msg-${m.id}`}>
              <MessageItem
                message={m}
                ttsSupported={tts.isSupported}
                speechState={tts.state}
                isActive={tts.activeId === m.id}
                canRegenerate={!busy && m.role === "assistant" && i === active.messages.length - 1 && i > 0}
                onPlay={() => tts.speak(m.id, plain(m.text))}
                onPause={tts.pause}
                onResume={tts.resume}
                onStop={tts.stop}
                onRestart={tts.restart}
                onRegenerate={handleRegenerate}
                onOpenArtifact={m.artifactHtml ? () => setArtifact(m.artifactHtml!) : undefined}
                onContinueFromHere={
                  canContinueFromHere(active.messages, i, active.activeGameMessageId)
                    ? () => handleContinueFromHere(m.id)
                    : undefined
                }
                isPinned={active.activeGameMessageId === m.id}
              />
              {/* New-game consent prompt (PRD §11): one tap, no typing. Only on
                  the latest reply, and only while idle. Both choices are safe —
                  the current game is untouched until the child picks. */}
              {m.newGamePrompt && !busy && i === active.messages.length - 1 && (
                <div className="mt-1 flex flex-wrap gap-2 pl-1">
                  <button
                    onClick={() => answerNewGamePrompt(m.id, active.messages[i - 1]?.text ?? "", "new-chat")}
                    className="rounded-full bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-500"
                  >
                    New game 🎮
                  </button>
                  <button
                    onClick={() => answerNewGamePrompt(m.id, active.messages[i - 1]?.text ?? "", "rebuild")}
                    className="rounded-full border border-neutral-200 px-4 py-2 text-sm text-neutral-700 hover:bg-neutral-50"
                  >
                    Change this one ✏️
                  </button>
                </div>
              )}
              {/* "Different one" (PRD-INSTANT-ALTERNATE): button intentionally
                  hidden for now — the copy read as misleading. The regenerate
                  path (handleDifferentOne → regenerate(true)) is kept intact so
                  we can resurface it via a clearer entry point later.
              {m.role === "assistant" && m.artifactHtml && !busy && i === active.messages.length - 1 && (
                <div className="mt-1 pl-1">
                  <button
                    onClick={handleDifferentOne}
                    className="rounded-full border border-neutral-200 px-4 py-2 text-sm text-neutral-700 hover:bg-neutral-50"
                  >
                    🔄 Different one
                  </button>
                </div>
              )}
              */}
              </div>
            ))}
            {busy && active.messages[active.messages.length - 1]?.text === "" && (
              <p className="animate-pulse text-neutral-400">
                {(() => {
                  const line = thinkingLine ?? waitLine(Date.now() - busyStartRef.current);
                  return line ? <>💭 <span className="italic">{line}</span></> : "Thinking… 💭";
                })()}
              </p>
            )}
            {active.messages.length === 1 && (
              <div className="flex flex-wrap gap-2 pt-2">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    onClick={() => handleSend(s)}
                    className="rounded-full border border-neutral-200 px-4 py-2 text-sm text-neutral-700 hover:bg-neutral-50"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        {active.activeGameMessageId && (
          <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-4 pb-2 text-sm text-warn-600">
            <span>🔧 Your next message will build on the earlier version above, not the newest one.</span>
            <button
              onClick={() => patchActive((c) => ({ ...c, activeGameMessageId: undefined }))}
              className="shrink-0 font-medium underline hover:text-warn-500"
            >
              Cancel
            </button>
          </div>
        )}
        {/* The waiting line, right above the composer where the kid typed it. */}
        <IdeaQueue
          ideas={queuedIdeas}
          paused={queuePaused}
          onEdit={(id, text) => patchQueue((q) => updateQueuedIdea(q, id, text))}
          onDrop={(id) => patchQueue((q) => removeQueuedIdea(q, id))}
          onResume={() => setQueuePaused(false)}
          onDropAll={() => patchQueue(() => [])}
        />
        {/* Never `disabled` any more (docs/PRD-IDEA-QUEUE.md): while Ari builds,
            the composer queues instead of dying. */}
        <Composer
          busy={busy}
          queueing={busy}
          queueFull={!canQueue(queuedIdeas)}
          onSend={handleComposerSend}
          onStop={handleStop}
        />
      </main>

      {/* z-[110]: must sit ABOVE the sticky brand nav (.ar-nav, z-100) — at
          z-40 the nav floated over the panel's header and swallowed every tap
          on ← Chat / ✕ (BUG-FIX-LOG 2026-07-07: "can't come out"). */}
      {artifact && (
        <div
          className={panelShellClass(previewExpanded)}
          // Pull-to-resize drives the CSS var so the subtree (and the running
          // game's iframe) never remounts — same principle as expand.
          style={
            panelWidth && !previewExpanded
              ? ({ "--panel-w": `${panelWidth}px` } as React.CSSProperties)
              : undefined
          }
        >
          {!previewExpanded && (
            <PanelResizeHandle
              width={panelWidth ?? PANEL_DEFAULT_W}
              onResize={setPanelWidth}
              onCommit={(w) => {
                setPanelWidth(w);
                savePanelWidth(window.localStorage, w);
              }}
            />
          )}
          <ArtifactFrame
            html={artifact}
            busy={busy}
            // Themed preview leaderboard (PRD-PREVIEW-WYSIWYG): biblical seed
            // names on the teacher surface, generic names elsewhere.
            previewTheme={workspace === "bible-teacher" ? "bible" : "default"}
            // Publishing fixes the game to the "Bible games" category + separate
            // listing (PRD-BIBLE-TEACHER §5) for anyone on the teacher surface —
            // surface-driven, not adult-gated (age verification gates ACCESS, not
            // publishing; owner direction 2026-07-23).
            bibleTeacher={publishesAsBible}
            // The kid's latest ask — self-healing repair prompts carry it so a
            // fix never drifts from intent (PRD §7 / R.5).
            originalRequest={[...active.messages].reverse().find((m) => m.role === "child")?.text ?? ""}
            onClose={() => {
              setArtifact(null);
              setExpandState({ expanded: false });
            }}
            expanded={previewExpanded}
            onToggleExpand={() => setExpandState(nextExpandOnManualToggle)}
            ideas={baggedIdeas.map((i) => ({ id: i.id, text: i.text }))}
            onCaptureIdea={(text) => {
              setIdeas((list) => addIdea(list, activeId, text));
              // The feature has been used — the re-nudge is off forever.
              setCoachStore((s) => (s.everCaptured ? s : { ...s, everCaptured: true }));
            }}
            onDiscardIdea={(id) => setIdeas((list) => discardIdea(list, id))}
            onEditIdea={(id, text) => setIdeas((list) => updateIdeaText(list, id, text))}
            onMakeBetter={handleMakeBetter}
            // Only the "waiting for the current build" case shows the ⏳ pill —
            // an idle tap resolves within a tick, so gating on busy avoids a flash.
            makeBetterQueued={queuedMakeBetter && busy}
            // micSupported is enforced structurally: IdeaMicTab renders
            // nothing (tab OR coach) when Web Speech is unavailable.
            coach={shouldShowCoach({ seen: coachStore.seen, busy, micSupported: true })}
            onCoachDone={() => setCoachStore((s) => ({ ...s, seen: true }))}
            nudgeMic={shouldRenudge(coachStore)}
            onNudgeShown={() => setCoachStore((s) => ({ ...s, renudged: true }))}
          />
        </div>
      )}

      {gate && (
        // On the bible-teacher surface the sign-in wall routes through the
        // platform age gate (sign-in + adult self-declaration + consent) so the
        // teacher persona can be unlocked; every other surface signs in plainly.
        <LoginGate message={gate.text} showUpgrade={gate.upgrade} onSignIn={() => (persona ? verifyAge() : signIn())} />
      )}
    </div>
  );
}
