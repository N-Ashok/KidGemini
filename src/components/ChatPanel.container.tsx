"use client";
// Container: owns conversations + chat state, talks to /api/chat (the safety boundary),
// and drives the sidebar, message list (markdown + read-aloud), composer, and artifact panel.
// Naming: `.container.tsx` = data-fetching component (CLAUDE.md § 5).

import { useEffect, useMemo, useRef, useState } from "react";
import { signIn, useSession } from "@/lib/useAriantraSession";
import { Sidebar } from "./Sidebar";
import { Composer, type Attachment } from "./Composer";
import { ArtifactFrame } from "./ArtifactFrame";
import { MessageItem } from "./MessageItem";
import { LoginGate } from "./LoginGate";
import { useTextToSpeech } from "./useTextToSpeech";
import type { ChatMessage, Conversation } from "@/types/chat.types";
import type { IdeaRecord } from "@/types/idea-bag.types";
import { loadChats, saveChats } from "@/lib/chat-store";
import {
  addIdea,
  baggedFor,
  composeIdeaBundle,
  discardIdea,
  loadIdeas,
  markSent,
  saveIdeas,
} from "@/lib/idea-bag";
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
  loadPanelWidth,
  nextArtifact,
  PANEL_DEFAULT_W,
  panelShellClass,
  savePanelWidth,
} from "@/lib/preview-pane";
import { PanelResizeHandle } from "./PanelResizeHandle";
import { searchChats } from "@/lib/chat-search";
import { appendPage, mergeRecents, SYNC_FLAG } from "@/lib/chat-sync";
import type { ConvoSummary } from "@/types/chat-history.types";
import { pickSuggestions } from "@/lib/game-suggestions";
import { shouldAutoRetry } from "@/lib/stream-recovery";
import { pollTurnResult } from "@/lib/turn-resume";
import { savePendingTurn, clearPendingTurn, loadPendingTurn } from "@/lib/pending-turn";
import { waitLine } from "@/lib/wait-line";
import { useWakeLock } from "./useWakeLock";

const KIND_FALLBACK = "Let's talk about something else! How about a game? 🌟";

function newConversation(): Conversation {
  return {
    id: crypto.randomUUID(),
    title: "New chat",
    messages: [
      {
        id: crypto.randomUUID(),
        role: "assistant",
        text: "Hi! I'm your buddy. Ask me anything, or say **make me a game**! 🌟",
        createdAt: Date.now(),
      },
    ],
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

export function ChatPanelContainer() {
  const { status: authStatus } = useSession();
  const [convos, setConvos] = useState<Conversation[]>([newConversation()]);
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
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false); // mobile drawer; always visible on md+
  const [searchQuery, setSearchQuery] = useState(""); // sidebar chat search (title + message text)
  // Server-side history (TECH_DEBT #26): the paginated Recents index from
  // /api/chats. Chats live durably on the server keyed by account/guest
  // cookie; localStorage is just the warm cache. remoteIndex holds summaries
  // only — a chat's messages are fetched when the kid opens it.
  const [remoteIndex, setRemoteIndex] = useState<ConvoSummary[]>([]);
  const [remoteHasMore, setRemoteHasMore] = useState(false);
  const remoteIndexRef = useRef<ConvoSummary[]>([]);
  remoteIndexRef.current = remoteIndex;
  const remoteLoadingRef = useRef(false);
  // Set when the server stops the guest: sign-in gate (token limit), rate-limit, or pay wall.
  const [gate, setGate] = useState<{ text: string; upgrade: boolean } | null>(null);
  // Starter chips: a fresh random four per load AND per chat switch. Picked in
  // an effect — not at render — so the server HTML matches the first client
  // render (random at render = hydration mismatch).
  const [suggestions, setSuggestions] = useState<string[]>([]);
  useEffect(() => setSuggestions(pickSuggestions(4)), [activeId]);
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

  const hydratedFromStore = useRef(false);
  useEffect(() => {
    if (hydratedFromStore.current) return;
    hydratedFromStore.current = true;
    const saved = loadChats(window.localStorage);
    if (saved) {
      setConvos(saved.convos);
      setActiveId(saved.activeId);
    }
    setIdeas(loadIdeas(window.localStorage));
    setCoachStore(loadCoach(window.localStorage));
    const w = loadPanelWidth(window.localStorage);
    if (w) setPanelWidth(clampPanelWidth(w, window.innerWidth));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (hydratedFromStore.current) saveChats(window.localStorage, convos, activeId);
  }, [convos, activeId]);

  /** Fetch the next page of the server Recents index (30/page). Reentrant-safe. */
  async function loadMoreRemote(reset = false) {
    if (remoteLoadingRef.current) return;
    remoteLoadingRef.current = true;
    try {
      const cursor = !reset ? remoteIndexRef.current.at(-1) : undefined;
      const qs = cursor ? `?before=${cursor.updatedAt}&beforeId=${encodeURIComponent(cursor.id)}` : "";
      const res = await fetch(`/api/chats${qs}`, { cache: "no-store" });
      if (!res.ok) return;
      const { chats } = (await res.json()) as { chats: ConvoSummary[] };
      setRemoteHasMore(chats.length >= 30);
      setRemoteIndex((prev) => (reset ? chats : appendPage(prev, chats)));
    } catch {
      /* offline — the local cache still works; next scroll retries */
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
                }).catch(() => {});
              }
              return next;
            });
          }
        }
      } catch {
        /* recovery is best-effort — never block the app load */
      }
      try {
        const saved = loadChats(window.localStorage);
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
      await loadMoreRemote(true);
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
        if (!res.ok) return;
        setRemoteIndex((prev) => [
          { id: c.id, title: c.title, updatedAt: Date.now() },
          ...prev.filter((r) => r.id !== c.id),
        ]);
      })
      .catch(() => {
        /* offline — local cache covers it until the next turn */
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
    const c = newConversation();
    setConvos((list) => [c, ...list]);
    setActiveId(c.id);
    setArtifact(null);
    setPreviewExpanded(false);
    setSearchQuery("");
    setSidebarOpen(false);
  }

  function handleSelect(id: string) {
    tts.stop();
    setArtifact(null);
    setPreviewExpanded(false);
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
  ) {
    const setReply = (t: string, artifactHtml?: string) =>
      patchActive((c) => ({
        ...c,
        messages: c.messages.map((m) => (m.id === replyId ? { ...m, text: t, artifactHtml } : m)),
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
        body: JSON.stringify({ message: text, history, replyId, ...(image ? { image } : {}) }),
        signal: controller.signal,
      });
      // Fail loud, never hang: a non-streaming response (401 auth gate, 4xx/5xx, or a body-less
      // reply from a proxy) must surface here instead of stalling on getReader() until the 30s
      // stall timeout. See BUG-FIX-LOG: "silent hang on non-streaming response".
      if (!res.ok || !res.body) {
        // Gate statuses (silent-hang prevention: blocks travel as HTTP statuses).
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        if (res.status === 401) {
          setReply(body.message ?? "Please sign in to continue using KidGemini ✨");
          setGate({ text: body.message ?? "Please sign in to continue using KidGemini ✨", upgrade: false });
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
          const ev = JSON.parse(line) as { type: string; text?: string; artifactHtml?: string | null };
          if (ev.type === "thinking") {
            if (ev.text) setThinkingLine(ev.text);
          } else if (ev.type === "delta") {
            if (!firstTokenAt) { firstTokenAt = Date.now(); console.log(`[chat] first token @${firstTokenAt - startedAt}ms`); }
            acc += ev.text ?? "";
            setReply(acc);
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
            setReply(ev.text ?? acc, ev.artifactHtml ?? undefined);
            setArtifact((a) => nextArtifact({ type: "done", artifactHtml: ev.artifactHtml }, a));
            setBusy(false);
            finalized = true;
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
            setGate({ text: ev.text ?? "Sign in with Google to keep chatting!", upgrade: false });
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
        setReply(acc || "⏹ Stopped."); // user pressed Stop — keep whatever streamed
        console.warn(`[chat] stopped by user after ${Date.now() - startedAt}ms`);
      } else if (finalized) {
        console.warn(`[chat] post-finalize stream drop (ignored) after ${Date.now() - startedAt}ms`);
      } else if (shouldAutoRetry({ manualStop: manualStopRef.current, finalized, attempt })) {
        // Retry by ourselves (BUG-FIX-LOG 2026-07-09) — "Ask me again" put the
        // recovery work on the kid, and screen-lock drops happen constantly.
        willRetry = true;
        console.warn(`[chat] ↻ stream ${aborted ? "stalled" : "dropped"} after ${Date.now() - startedAt}ms — auto-retry ${attempt + 1}`);
        setReply(`${acc ? `${acc}\n\n---\n` : ""}📶 Reconnecting… hang tight!`);
      } else {
        console.error(`[chat] ✖ ${aborted ? "STALLED (no tokens 30s)" : "stream error"} after ${Date.now() - startedAt}ms (retries exhausted)`, err);
        // NEVER discard what already streamed (BUG-FIX-LOG 2026-07-07: phones
        // drop the socket on screen-lock/app-switch mid-generation — the kid
        // watched the code arrive, then "Oops" ATE it). Keep the partial reply
        // and append a friendly next step instead.
        const note = aborted
          ? "\n\n---\n😅 That took too long — the model is busy. Ask me again!"
          : "\n\n---\n📶 The connection keeps hiccuping — I tried a few times. Ask me again and I'll redo it!";
        setReply(acc ? acc + note : note.replace(/^\n+---\n/, ""));
      }
    } finally {
      clearTimeout(stall);
      abortRef.current = null;
      // A finalized turn (or a manual stop) has nothing left to recover.
      // Exhausted retries deliberately KEEP the bookmark — a later reload can
      // still collect the reply the server finished on its own.
      if (finalized || manualStopRef.current) clearPendingTurn(window.localStorage);
      if (!willRetry) setBusy(false); // stay "busy" across a retry — no flicker, Stop still works
      console.log(`[chat] finished; total ${Date.now() - startedAt}ms${willRetry ? " (retrying)" : ""}`);
    }

    if (willRetry) {
      await whenVisible(); // screen locked? wait for the kid to come back first
      await new Promise((r) => setTimeout(r, 800));
      if (manualStopRef.current) {
        setReply(acc || "⏹ Stopped.");
        setBusy(false);
        return;
      }
      // Resume before re-generating (TECH_DEBT #23 shipped): the server kept
      // generating while we were detached — under heavy load the reply is
      // usually FINISHED (or still cooking: `running` gets minutes of free
      // patience). Only a genuine server-side failure re-generates (paid).
      const resumed = await pollTurnResult(replyId);
      if (manualStopRef.current) {
        setReply(acc || "⏹ Stopped.");
        setBusy(false);
        return;
      }
      if (resumed) {
        console.log(`[chat] ↻ resumed the finished reply from the server (no re-generation)`);
        setReply(resumed.text, resumed.artifactHtml ?? undefined);
        setArtifact((a) => nextArtifact({ type: "done", artifactHtml: resumed.artifactHtml }, a));
        clearPendingTurn(window.localStorage);
        setBusy(false);
        onSuccess?.();
        return;
      }
      await runStream(text, history, replyId, attempt + 1, image, onSuccess);
    }
  }

  async function handleSend(
    text: string,
    attachment?: Attachment,
    opts?: { fromIdeaBag?: boolean; onSuccess?: (childId: string) => void },
  ) {
    const history = active.messages;
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
        { id: replyId, role: "assistant", text: "", createdAt: Date.now() },
      ],
    }));
    await runStream(apiMessage, history, replyId, 0, image, opts?.onSuccess && (() => opts.onSuccess!(childId)));
  }

  // ✨ Make my game better! — the whole bag becomes ONE visible chat message
  // (no hidden side-channel); ideas flip to `sent` only when the generation
  // finishes, so failures keep every thought safely bagged.
  async function handleMakeBetter() {
    if (busy) return;
    const bagged = baggedFor(ideas, activeId);
    const bundle = composeIdeaBundle(bagged.map((i) => i.text));
    if (!bundle) return;
    const convoId = activeId;
    setPreviewExpanded(false); // watch the send land in chat (desktop split view)
    // Mobile: the panel covers the whole screen — flip to the chat so the kid
    // SEES the bundle post; the updated game re-opens the panel via `done`.
    if (window.matchMedia("(max-width: 767px)").matches) setArtifact(null);
    await handleSend(bundle, undefined, {
      fromIdeaBag: true,
      onSuccess: (childId) => setIdeas((list) => markSent(list, convoId, childId)),
    });
  }

  function handleStop() {
    manualStopRef.current = true;
    abortRef.current?.abort();
  }

  // Regenerate: re-run the last user prompt, replacing the last answer.
  async function handleRegenerate() {
    if (busy) return;
    const msgs = active.messages;
    let idx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]!.role === "child") { idx = i; break; }
    if (idx === -1) return;
    const userText = msgs[idx]!.text;
    const history = msgs.slice(0, idx);
    const replyId = crypto.randomUUID();
    // Keep the old game on screen and playable until the redo lands
    // (PRD-PREVIEW-PANE §2 — regenerate used to blank the panel here).
    setArtifact((a) => nextArtifact({ type: "regenerate" }, a));
    anchorIdRef.current = msgs[idx]!.id; // re-pin the request being regenerated
    patchActive((c) => ({
      ...c,
      messages: [
        ...c.messages.slice(0, idx + 1),
        { id: replyId, role: "assistant", text: "", createdAt: Date.now() },
      ],
    }));
    await runStream(userText, history, replyId, 0, sessionImagesRef.current.get(activeId));
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
          <span className="text-base font-semibold text-neutral-700">✨ KidGemini</span>
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
              />
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
        <Composer disabled={busy} busy={busy} onSend={handleSend} onStop={handleStop} />
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
            // The kid's latest ask — self-healing repair prompts carry it so a
            // fix never drifts from intent (PRD §7 / R.5).
            originalRequest={[...active.messages].reverse().find((m) => m.role === "child")?.text ?? ""}
            onClose={() => {
              setArtifact(null);
              setPreviewExpanded(false);
            }}
            expanded={previewExpanded}
            onToggleExpand={() => setPreviewExpanded((v) => !v)}
            ideas={baggedIdeas.map((i) => ({ id: i.id, text: i.text }))}
            onCaptureIdea={(text) => {
              setIdeas((list) => addIdea(list, activeId, text));
              // The feature has been used — the re-nudge is off forever.
              setCoachStore((s) => (s.everCaptured ? s : { ...s, everCaptured: true }));
            }}
            onDiscardIdea={(id) => setIdeas((list) => discardIdea(list, id))}
            onMakeBetter={handleMakeBetter}
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
        <LoginGate message={gate.text} showUpgrade={gate.upgrade} onSignIn={() => signIn()} />
      )}
    </div>
  );
}
