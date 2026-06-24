"use client";
// Renders assistant replies as rich markdown (headings, bold, lists, code) like Gemini.
// Fenced code blocks get a Gemini/Claude-style header (language + copy). Presentational;
// base styling lives in the `.markdown` rules in globals.css.

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { downloadCode } from "./download";

function CodeBlock({ className, children }: { className?: string; children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const lang = /language-(\w+)/.exec(className ?? "")?.[1] ?? "";
  const code = String(children ?? "").replace(/\n$/, "");
  const isBlock = Boolean(lang) || code.includes("\n");

  if (!isBlock) {
    return <code className="rounded bg-neutral-100 px-1.5 py-0.5 text-[13px] font-mono">{children}</code>;
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  function download() {
    downloadCode(code, lang);
  }

  return (
    <div className="my-3 overflow-hidden rounded-xl border border-neutral-700 bg-neutral-900">
      <div className="flex items-center justify-between border-b border-neutral-700 px-3 py-1.5">
        <span className="text-xs font-medium text-neutral-400">{lang || "code"}</span>
        <div className="flex items-center gap-3">
          <button onClick={download} className="text-xs text-neutral-300 hover:text-white">
            ⬇ Download
          </button>
          <button onClick={copy} className="text-xs text-neutral-300 hover:text-white">
            {copied ? "✓ Copied" : "⧉ Copy"}
          </button>
        </div>
      </div>
      <pre className="overflow-x-auto p-4 text-[12.5px] leading-5 text-neutral-100">
        <code>{code}</code>
      </pre>
    </div>
  );
}

const components: Components = {
  code: CodeBlock as Components["code"],
  pre: ({ children }) => <>{children}</>, // CodeBlock owns the block layout
};

export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
