"use client";
// Trigger a client-side file download for a code snippet. Single responsibility.

const LANG_EXT: Record<string, string> = {
  html: "html",
  js: "js",
  javascript: "js",
  ts: "ts",
  typescript: "ts",
  css: "css",
  json: "json",
  python: "py",
  py: "py",
};

export function downloadCode(code: string, lang = "", filename?: string): void {
  const ext = LANG_EXT[lang.toLowerCase()] ?? "txt";
  const name = filename ?? `snippet.${ext}`;
  const blob = new Blob([code], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
