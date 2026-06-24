"use client";
// Gemini-style composer: rounded bar with a + action, growing textarea, model selector,
// mic (speech-to-text), and a send button that appears once there's text.
// Presentational; raises events via props.

import { useRef, useState } from "react";
import { useSpeechInput } from "./useSpeechInput";

export interface Attachment {
  name: string;
  content: string;
}

interface ComposerProps {
  disabled?: boolean;
  busy?: boolean;
  model: string;
  onSend: (text: string, attachment?: Attachment) => void;
  onStop?: () => void;
}

const ACCEPT = ".html,.htm,.txt,.js,.ts,.css,.json,.md,.csv";
const MAX_FILE_BYTES = 200_000;

export function Composer({ disabled, busy, model, onSend, onStop }: ComposerProps) {
  const [value, setValue] = useState("");
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [fileError, setFileError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const { isListening, isSupported, toggle, start, stop } = useSpeechInput((text) =>
    setValue((v) => (v ? `${v} ${text}` : text)),
  );

  function handleRestart() {
    setValue("");
    stop();
    // brief gap so recognition fully stops before restarting
    setTimeout(start, 150);
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    setFileError("");
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setFileError("That file is too big (max 200 KB).");
      return;
    }
    try {
      const content = await file.text();
      setAttachment({ name: file.name, content });
    } catch {
      setFileError("Couldn't read that file.");
    }
  }

  function submit() {
    const text = value.trim();
    if ((!text && !attachment) || disabled) return;
    onSend(text, attachment ?? undefined);
    setValue("");
    setAttachment(null);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-4">
      {isListening && (
        <div className="mb-2 flex items-center justify-between rounded-2xl border border-blue-200 bg-blue-50 px-4 py-2">
          <span className="flex items-center gap-2 text-sm font-medium text-blue-700">
            <span className="mic-listening text-lg" aria-hidden>🎙️</span> Listening…
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={stop}
              className="rounded-full px-3 py-1 text-sm font-medium text-blue-700 hover:bg-blue-100"
            >
              ⏸ Pause
            </button>
            <button
              type="button"
              onClick={handleRestart}
              className="rounded-full px-3 py-1 text-sm font-medium text-blue-700 hover:bg-blue-100"
            >
              🔁 Restart
            </button>
          </div>
        </div>
      )}
      {attachment && (
        <div className="mb-2 flex items-center gap-2 rounded-2xl border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm">
          <span aria-hidden>📎</span>
          <span className="truncate font-medium text-neutral-700">{attachment.name}</span>
          <span className="text-neutral-400">({Math.ceil(attachment.content.length / 1024)} KB)</span>
          <button
            type="button"
            onClick={() => setAttachment(null)}
            className="ml-auto rounded-full px-2 text-neutral-500 hover:bg-neutral-200"
            aria-label="Remove attachment"
          >
            ✕
          </button>
        </div>
      )}
      {fileError && <p className="mb-1 px-2 text-sm text-red-600">{fileError}</p>}
      <div className="flex items-end gap-2 rounded-[28px] border border-neutral-200 bg-white px-3 py-2 shadow-sm">
        <input
          ref={fileInput}
          type="file"
          accept={ACCEPT}
          onChange={handleFile}
          className="hidden"
        />
        <button
          type="button"
          aria-label="Attach a file"
          title="Attach a file"
          onClick={() => fileInput.current?.click()}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-2xl text-neutral-500 hover:bg-neutral-100"
        >
          +
        </button>

        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          placeholder="Ask me anything…"
          disabled={disabled}
          className="max-h-40 flex-1 resize-none bg-transparent py-2.5 text-[15px] leading-6 text-neutral-800 outline-none placeholder:text-neutral-400"
        />

        <div className="flex shrink-0 items-center gap-1">
          <span className="flex items-center gap-1 rounded-full px-3 py-1.5 text-sm text-neutral-500">
            {model.replace("gemini-2.5-", "").replace("-", " ")} <span aria-hidden>⌄</span>
          </span>

          {isSupported && (
            <button
              type="button"
              onClick={toggle}
              aria-label={isListening ? "Stop listening" : "Talk"}
              aria-pressed={isListening}
              className={`flex h-10 w-10 items-center justify-center rounded-full text-xl
                ${isListening ? "mic-listening bg-red-500 text-white" : "text-neutral-600 hover:bg-neutral-100"}`}
            >
              🎤
            </button>
          )}

          {busy ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop generating"
              title="Stop"
              className="flex h-10 w-10 items-center justify-center rounded-full bg-neutral-800 text-white hover:bg-neutral-700"
            >
              ◼
            </button>
          ) : (
            (value.trim() || attachment) && (
              <button
                type="button"
                onClick={submit}
                aria-label="Send"
                className="flex h-10 w-10 items-center justify-center rounded-full bg-neutral-800 text-white hover:bg-neutral-700 disabled:opacity-40"
              >
                ↑
              </button>
            )
          )}
        </div>
      </div>
      <p className="pt-2 text-center text-xs text-neutral-400">
        KidGemini is AI and can make mistakes. A grown-up keeps you safe. 🛡️
      </p>
    </div>
  );
}
