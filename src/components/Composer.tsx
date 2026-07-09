"use client";
// Gemini-style composer: rounded bar with a + action, growing textarea,
// mic (speech-to-text), and a send button that appears once there's text.
// Presentational; raises events via props.

import { useEffect, useRef, useState } from "react";
import { useSpeechInput } from "./useSpeechInput";

export type Attachment =
  | { kind: "text"; name: string; content: string }
  | { kind: "image"; name: string; mimeType: "image/jpeg"; data: string; previewUrl: string };

interface ComposerProps {
  disabled?: boolean;
  busy?: boolean;
  onSend: (text: string, attachment?: Attachment) => void;
  onStop?: () => void;
}

// Pictures (context for the model) + the code/text types games are made of.
const ACCEPT = "image/*,.html,.htm,.txt,.js,.ts,.css,.json,.md,.csv";
const MAX_FILE_BYTES = 200_000;
const MAX_IMAGE_BYTES = 15_000_000; // raw camera photos; downscaled before sending
const MAX_IMAGE_EDGE_PX = 1024;
// Matches max-h-40 (10rem) — the textarea grows to here, then scrolls.
const MAX_TEXTAREA_PX = 160;

export function Composer({ disabled, busy, onSend, onStop }: ComposerProps) {
  const [value, setValue] = useState("");
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [fileError, setFileError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow: track the content's height whether it was typed, dictated, or
  // cleared on send — an effect on `value` covers all three paths.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_PX)}px`;
  }, [value]);
  const { isListening, isSupported, error: micError, clearError: clearMicError, toggle, start, stop } = useSpeechInput(
    (text) => setValue((v) => (v ? `${v} ${text}` : text)),
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

    if (file.type.startsWith("image/")) {
      if (file.size > MAX_IMAGE_BYTES) {
        setFileError("That picture is too big — try a smaller one.");
        return;
      }
      try {
        // Downscale to ≤1024px JPEG: keeps the payload ~100-200 KB (localStorage
        // and request-size safe) and normalizes any camera format (HEIC included,
        // where the browser can decode it) to a type the server allow-lists.
        const previewUrl = await downscaleImage(file, MAX_IMAGE_EDGE_PX);
        const data = previewUrl.split(",")[1] ?? "";
        if (!data) throw new Error("empty");
        setAttachment({ kind: "image", name: file.name, mimeType: "image/jpeg", data, previewUrl });
      } catch {
        setFileError("Couldn't read that picture — try a JPG or PNG. 📷");
      }
      return;
    }

    if (file.size > MAX_FILE_BYTES) {
      setFileError("That file is too big (max 200 KB).");
      return;
    }
    try {
      const content = await file.text();
      setAttachment({ kind: "text", name: file.name, content });
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
      {micError && !isListening && (
        <div className="mb-2 flex items-center justify-between rounded-2xl border border-amber-200 bg-amber-50 px-4 py-2">
          <span className="text-sm font-medium text-amber-800">{micError}</span>
          <button type="button" onClick={clearMicError} aria-label="Dismiss" className="rounded-full px-2 text-amber-800 hover:bg-amber-100">✕</button>
        </div>
      )}
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
          {attachment.kind === "image" ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={attachment.previewUrl} alt="" className="h-10 w-10 rounded-lg object-cover" />
          ) : (
            <span aria-hidden>📎</span>
          )}
          <span className="truncate font-medium text-neutral-700">{attachment.name}</span>
          {attachment.kind === "text" && (
            <span className="text-neutral-400">({Math.ceil(attachment.content.length / 1024)} KB)</span>
          )}
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
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          placeholder="Ask me anything…"
          disabled={disabled}
          className="max-h-40 flex-1 resize-none overflow-y-auto bg-transparent py-2.5 text-[15px] leading-6 text-neutral-800 outline-none placeholder:text-neutral-400 focus-visible:ring-0 focus-visible:ring-offset-0"
        />

        <div className="flex shrink-0 items-center gap-1">
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

/** Decode → fit within maxEdge → re-encode as a JPEG data URL. Throws if the
 *  browser can't decode the file (surfaced as a friendly picker error). */
async function downscaleImage(file: File, maxEdge: number): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    bitmap.close();
  }
}
