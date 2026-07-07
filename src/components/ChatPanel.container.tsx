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

const CHAT_MODEL_LABEL = "flash lite"; // display only; real model is server-side
const KIND_FALLBACK = "Let's talk about something else! How about a game? 🌟";
// Game-making platform → every starter is a GAME (user decision 2026-07-07),
// four different genres so kids see the range.
const SUGGESTIONS = [
  "Make me a car racing game 🏎️",
  "Make me a space shooter with aliens 👾",
  "Make me a dino jump-and-run game 🦖",
  "Make me a puzzle game with colors 🧩",
];

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
  // Set when the server stops the guest: sign-in gate (token limit), rate-limit, or pay wall.
  const [gate, setGate] = useState<{ text: string; upgrade: boolean } | null>(null);
  const tts = useTextToSpeech();

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
    () => convos.map((c) => ({ id: c.id, title: c.title })),
    [convos],
  );

  // Auto-scroll: follow new content to the bottom as it streams in, unless the user has
  // scrolled up to read (then leave them where they are — like Gemini).
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [active.messages]);
  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  function patchActive(fn: (c: Conversation) => Conversation) {
    setConvos((list) => list.map((c) => (c.id === activeId ? fn(c) : c)));
  }

  const abortRef = useRef<AbortController | null>(null);
  const manualStopRef = useRef(false);

  function handleNewChat() {
    tts.stop();
    const c = newConversation();
    setConvos((list) => [c, ...list]);
    setActiveId(c.id);
    setArtifact(null);
    setSidebarOpen(false);
  }

  function handleSelect(id: string) {
    tts.stop();
    setActiveId(id);
    setArtifact(null);
    setSidebarOpen(false);
  }

  // Core streaming routine, shared by send + regenerate. Fills the message `replyId`.
  async function runStream(text: string, history: ChatMessage[], replyId: string) {
    const setReply = (t: string, artifactHtml?: string) =>
      patchActive((c) => ({
        ...c,
        messages: c.messages.map((m) => (m.id === replyId ? { ...m, text: t, artifactHtml } : m)),
      }));

    const STALL_MS = 30_000;
    const controller = new AbortController();
    abortRef.current = controller;
    manualStopRef.current = false;
    let stall = setTimeout(() => controller.abort(), STALL_MS);
    const bump = () => { clearTimeout(stall); stall = setTimeout(() => controller.abort(), STALL_MS); };
    const startedAt = Date.now();
    let firstTokenAt = 0;
    let finalized = false;
    let acc = "";
    setBusy(true);
    console.log(`[chat] ▶ sending: "${text.slice(0, 60)}"`);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, history }),
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
      } else {
        console.error(`[chat] ✖ ${aborted ? "STALLED (no tokens 30s)" : "stream error"} after ${Date.now() - startedAt}ms`, err);
        setReply(
          aborted
            ? "That took too long 😅 — the model is busy. Try again, or ask for something simpler."
            : "Oops! Something went wrong. Let's try again.",
        );
      }
    } finally {
      clearTimeout(stall);
      abortRef.current = null;
      setBusy(false);
      console.log(`[chat] finished; total ${Date.now() - startedAt}ms`);
    }
  }

  async function handleSend(text: string, attachment?: Attachment) {
    const history = active.messages;
    const replyId = crypto.randomUUID();
    const displayText = text || (attachment ? "" : "");
    // What the model receives: the file contents folded in, but kept out of the bubble.
    const apiMessage = attachment
      ? `The child attached a file named "${attachment.name}". Its contents:\n\`\`\`\n${attachment.content}\n\`\`\`\n\n${text || "Please take a look at this file."}`
      : text;
    patchActive((c) => ({
      ...c,
      title: c.title === "New chat" ? (text || attachment?.name || "New chat").slice(0, 40) : c.title,
      messages: [
        ...c.messages,
        { id: crypto.randomUUID(), role: "child", text: displayText, attachmentName: attachment?.name, createdAt: Date.now() },
        { id: replyId, role: "assistant", text: "", createdAt: Date.now() },
      ],
    }));
    await runStream(apiMessage, history, replyId);
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
    patchActive((c) => ({
      ...c,
      messages: [
        ...c.messages.slice(0, idx + 1),
        { id: replyId, role: "assistant", text: "", createdAt: Date.now() },
      ],
    }));
    await runStream(userText, history, replyId);
  }

  // Guests may chat up to the free-token trial (server-enforced); the sign-in
  // wall arrives as an HTTP 401 → LoginGate. No upfront block anymore.
  return (
    <div className="flex h-full w-full bg-white text-neutral-900">
      <Sidebar
        recents={recents}
        activeId={activeId}
        isOpen={sidebarOpen}
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
        <div ref={scrollRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8">
            {active.messages.map((m, i) => (
              <MessageItem
                key={m.id}
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
            ))}
            {busy && active.messages[active.messages.length - 1]?.text === "" && (
              <p className="animate-pulse text-neutral-400">Thinking… 💭</p>
            )}
            {active.messages.length === 1 && (
              <div className="flex flex-wrap gap-2 pt-2">
                {SUGGESTIONS.map((s) => (
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
        <Composer disabled={busy} busy={busy} model={CHAT_MODEL_LABEL} onSend={handleSend} onStop={handleStop} />
      </main>

      {/* z-[110]: must sit ABOVE the sticky brand nav (.ar-nav, z-100) — at
          z-40 the nav floated over the panel's header and swallowed every tap
          on ← Chat / ✕ (BUG-FIX-LOG 2026-07-07: "can't come out"). */}
      {artifact && (
        <div className="fixed inset-0 z-[110] bg-white md:static md:inset-auto md:z-auto md:w-[440px] md:border-l md:border-neutral-200">
          <ArtifactFrame html={artifact} busy={busy} onClose={() => setArtifact(null)} />
        </div>
      )}

      {gate && (
        <LoginGate message={gate.text} showUpgrade={gate.upgrade} onSignIn={() => signIn()} />
      )}
    </div>
  );
}
