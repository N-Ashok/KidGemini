"use client";
// Renders a single message Gemini-style: user = right-aligned gray bubble;
// assistant = full-width markdown with a read-aloud control row (play/pause/stop/restart).
// Presentational; TTS state + handlers come from the container via props.

import { useState } from "react";
import { Markdown } from "./Markdown";
import type { SpeechState } from "./useTextToSpeech";
import type { ChatMessage } from "@/types/chat.types";

interface MessageItemProps {
  message: ChatMessage;
  ttsSupported: boolean;
  speechState: SpeechState;
  isActive: boolean; // is this message the one currently being read
  canRegenerate: boolean;
  onPlay: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onRestart: () => void;
  onRegenerate: () => void;
  onOpenArtifact?: () => void; // set when the message carries artifactHtml
  onContinueFromHere?: () => void; // set when this earlier game message can become the pinned edit target
  isPinned: boolean; // this message IS the current "Continue from here" target
}

export function MessageItem(props: MessageItemProps) {
  const { message: m } = props;

  if (m.role === "child") {
    return (
      <div className="flex flex-col items-end gap-1">
        {/* No hidden side-channel: an Idea Bag send is a visible, labeled chat
            message — the kid (and a parent later) sees exactly what was asked. */}
        {m.fromIdeaBag && (
          <span className="px-2 text-xs font-bold text-neutral-400">🎒 From your Idea Bag</span>
        )}
        {m.attachmentName && (
          <span className="flex items-center gap-1.5 rounded-2xl border border-neutral-200 bg-neutral-50 px-3 py-1.5 text-sm text-neutral-600">
            <span aria-hidden>📎</span> {m.attachmentName}
          </span>
        )}
        {m.text && (
          <p className="max-w-[80%] whitespace-pre-wrap rounded-3xl bg-neutral-100 px-5 py-3 text-[15px] text-neutral-800">
            {m.text}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="group">
      <Markdown>{m.text}</Markdown>
      {m.artifactHtml && props.onOpenArtifact && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {/* Discoverability (owner UAT 2026-07-23): the leaderboard, sharing and
              high-scores live in the in-game ⋯ menu — kids won't find them
              otherwise. Say it right by the Open-game button. */}
          <p className="w-full text-xs text-neutral-500">
            ✨ Inside your game, tap the <span className="font-semibold">⋯</span> menu (top-right) for a{" "}
            <span className="font-semibold">leaderboard</span>, sharing &amp; more!
          </p>
          <button
            onClick={props.onOpenArtifact}
            className="flex items-center gap-2 rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-2.5 text-sm font-medium text-neutral-800 hover:border-neutral-300 hover:bg-neutral-100"
          >
            🎮 Open game
          </button>
          {props.onContinueFromHere && (
            <button
              onClick={props.onContinueFromHere}
              className="flex items-center gap-2 rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-2.5 text-sm font-medium text-neutral-800 hover:border-neutral-300 hover:bg-neutral-100"
            >
              ⏪ Continue from here
            </button>
          )}
          {props.isPinned && (
            <span className="flex items-center gap-1 rounded-2xl bg-warn-500/10 px-3 py-1.5 text-sm font-medium text-warn-600">
              🔧 Building from this version
            </span>
          )}
        </div>
      )}
      {m.text !== "" && (
        <div className="mt-1 flex items-center gap-1 text-neutral-400">
          <CopyButton text={m.text} />
          {props.ttsSupported && <ReadAloudControls {...props} />}
          {props.canRegenerate && (
            <button
              className="flex h-8 w-8 items-center justify-center rounded-full text-sm hover:bg-neutral-100 hover:text-neutral-700"
              aria-label="Regenerate"
              title="Regenerate"
              onClick={props.onRegenerate}
            >
              ↻
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }
  return (
    <button
      className="flex h-8 items-center justify-center rounded-full px-2 text-sm hover:bg-neutral-100 hover:text-neutral-700"
      aria-label="Copy"
      title="Copy"
      onClick={copy}
    >
      {copied ? "✓" : "⧉"}
    </button>
  );
}

function ReadAloudControls(props: MessageItemProps) {
  const { isActive, speechState } = props;
  const btn =
    "flex h-8 w-8 items-center justify-center rounded-full text-sm hover:bg-neutral-100 hover:text-neutral-700";

  // Not currently reading this message → show a single play button.
  if (!isActive || speechState === "idle") {
    return (
      <button className={btn} aria-label="Read aloud" title="Read aloud" onClick={props.onPlay}>
        🔊
      </button>
    );
  }

  return (
    <>
      {speechState === "speaking" ? (
        <button className={btn} aria-label="Pause" title="Pause" onClick={props.onPause}>
          ⏸
        </button>
      ) : (
        <button className={btn} aria-label="Resume" title="Resume" onClick={props.onResume}>
          ▶️
        </button>
      )}
      <button className={btn} aria-label="Restart" title="Restart" onClick={props.onRestart}>
        🔁
      </button>
      <button className={btn} aria-label="Stop" title="Stop" onClick={props.onStop}>
        ⏹
      </button>
    </>
  );
}
