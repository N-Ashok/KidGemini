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
import { loadChats, saveChats } from "@/lib/chat-store";
import { searchChats } from "@/lib/chat-search";
import { pickSuggestions } from "@/lib/game-suggestions";
import { shouldAutoRetry } from "@/lib/stream-recovery";
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
  const [artifact, setArtifact] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false); // mobile drawer; always visible on md+
  const [searchQuery, setSearchQuery] = useState(""); // sidebar chat search (title + message text)
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
  const hydratedFromStore = useRef(false);
  useEffect(() => {
    if (hydratedFromStore.current) return;
    hydratedFromStore.current = true;
    const saved = loadChats(window.localStorage);
    if (saved) {
      setConvos(saved.convos);
      setActiveId(saved.activeId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (hydratedFromStore.current) saveChats(window.localStorage, convos, activeId);
  }, [convos, activeId]);

  const active = convos.find((c) => c.id === activeId) ?? convos[0]!;
  const recents = useMemo(
    () => searchChats(convos, searchQuery).map((c) => ({ id: c.id, title: c.title })),
    [convos, searchQuery],
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
    setSearchQuery("");
    setSidebarOpen(false);
  }

  function handleSelect(id: string) {
    tts.stop();
    setActiveId(id);
    setArtifact(null);
    setSidebarOpen(false);
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
    console.log(`[chat] ▶ sending: "${text.slice(0, 60)}"`);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, history, ...(image ? { image } : {}) }),
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
          if (ev.type === "delta") {
            if (!firstTokenAt) { firstTokenAt = Date.now(); console.log(`[chat] first token @${firstTokenAt - startedAt}ms`); }
            acc += ev.text ?? "";
            setReply(acc);
          } else if (ev.type === "done") {
            setReply(ev.text ?? acc, ev.artifactHtml ?? undefined);
            if (ev.artifactHtml) setArtifact(ev.artifactHtml);
            setBusy(false);
            finalized = true;
            console.log(`[chat] ✓ shown @${Date.now() - startedAt}ms artifact=${ev.artifactHtml ? "yes" : "no"}`);
          } else if (ev.type === "retract") {
            setReply(ev.text ?? KIND_FALLBACK);
            setArtifact(null);
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
      await runStream(text, history, replyId, attempt + 1, image);
    }
  }

  async function handleSend(text: string, attachment?: Attachment) {
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
        { id: childId, role: "child", text: displayText, attachmentName: attachment?.name, createdAt: Date.now() },
        { id: replyId, role: "assistant", text: "", createdAt: Date.now() },
      ],
    }));
    await runStream(apiMessage, history, replyId, 0, image);
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
    setArtifact(null);
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
              <p className="animate-pulse text-neutral-400">Thinking… 💭</p>
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
        <div className="fixed inset-0 z-[110] bg-white md:static md:inset-auto md:z-auto md:w-[440px] md:border-l md:border-neutral-200">
          <ArtifactFrame
            html={artifact}
            busy={busy}
            // The kid's latest ask — self-healing repair prompts carry it so a
            // fix never drifts from intent (PRD §7 / R.5).
            originalRequest={[...active.messages].reverse().find((m) => m.role === "child")?.text ?? ""}
            onClose={() => setArtifact(null)}
          />
        </div>
      )}

      {gate && (
        <LoginGate message={gate.text} showUpgrade={gate.upgrade} onSignIn={() => signIn()} />
      )}
    </div>
  );
}
