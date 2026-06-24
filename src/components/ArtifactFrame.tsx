"use client";
// Renders model-generated HTML games with a Preview / Code toggle (Claude-artifact style).
// SECURITY: preview runs in a sandboxed iframe — sandbox="allow-scripts" only (no
// same-origin, no top-navigation, no forms). Presentational.

import { useState } from "react";
import { downloadCode } from "./download";

interface ArtifactFrameProps {
  html: string | null;
  onClose: () => void;
}

type Tab = "preview" | "code";

export function ArtifactFrame({ html, onClose }: ArtifactFrameProps) {
  const [tab, setTab] = useState<Tab>("preview");
  const [copied, setCopied] = useState(false);
  if (!html) return null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(html ?? "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  const tabBtn = (t: Tab, label: string) =>
    `rounded-full px-3 py-1 text-sm font-medium ${
      tab === t ? "bg-neutral-900 text-white" : "text-neutral-600 hover:bg-neutral-100"
    }`;

  return (
    <aside className="flex h-full w-full flex-col bg-white">
      <header className="flex items-center justify-between gap-2 border-b border-neutral-200 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <button onClick={() => setTab("preview")} className={tabBtn("preview", "Preview")}>
            ▶ Preview
          </button>
          <button onClick={() => setTab("code")} className={tabBtn("code", "Code")}>
            {"</>"} Code
          </button>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => downloadCode(html ?? "", "html", "game.html")}
            className="rounded-lg px-2 py-1 text-sm text-neutral-600 hover:bg-neutral-100"
            aria-label="Download game"
          >
            ⬇ Download
          </button>
          <button
            onClick={copy}
            className="rounded-lg px-2 py-1 text-sm text-neutral-600 hover:bg-neutral-100"
            aria-label="Copy HTML"
          >
            {copied ? "✓ Copied" : "⧉ Copy"}
          </button>
          <button
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-neutral-600 hover:bg-neutral-100"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
      </header>

      <p className="border-b border-neutral-100 px-4 py-1.5 text-xs text-neutral-400">
        Made by AI · runs safely in a sandbox
      </p>

      {tab === "preview" ? (
        <iframe
          title="AI-generated game"
          sandbox="allow-scripts"
          srcDoc={html}
          className="h-full w-full flex-1 border-0"
        />
      ) : (
        <pre className="h-full flex-1 overflow-auto bg-neutral-900 p-4 text-[12px] leading-5 text-neutral-100">
          <code>{html}</code>
        </pre>
      )}
    </aside>
  );
}
