// Preview WYSIWYG runtime injection (PRD-PREVIEW-WYSIWYG §7 step 3).
//
// Inlines the platform's preview-sdk.js (the REAL sdk.js + publish overlays 🏆⋯🔗
// + a LOCAL fetch-shim mock) into the sandboxed preview srcDoc, so the chat
// preview shows the SAME overlays a published game gets — what-you-see-is-what-
// you-publish — with no backend and no network (fully self-contained, works
// offline, matches the game-build "works offline" rule).
//
// This REPLACES the old multiplayer-only injectPreviewSdkStub in ArtifactFrame,
// and runs for EVERY game (not just SDK-using ones) so the overlays appear
// everywhere. Injected ONLY into the preview srcDoc — publish / 🎮 Invite send
// the RAW state.currentHtml, where the platform loads the real backend SDK.

import { PREVIEW_SDK_BUNDLE } from "@/generated/preview-sdk-bundle";

export type PreviewTheme = "default" | "bible";

/** Idempotency marker (same pattern as the console-capture / verify markers). */
export const PREVIEW_RUNTIME_MARKER = "<!--ari-preview-runtime-->";

/** The bundle carries the publish overlays as HTML strings that contain literal
 *  `</script>`; when we inline the bundle inside a `<script>…</script>`, an
 *  un-escaped `</script>` would terminate our script early. Neutralize it —
 *  `<\/script>` is identical to `</script>` inside a JS string, so the overlay
 *  markup still renders correctly, but the srcDoc `<script>` stays open. */
function escapeForInlineScript(js: string): string {
  return js.replace(/<\/(script)/gi, "<\\/$1");
}

/**
 * Prepend the preview runtime to `html`. Sets the theme global FIRST (the bundle
 * reads `window.ARIANTRA_PREVIEW` on load to seed themed leaderboard names),
 * then the runtime. Idempotent; injected at the earliest safe anchor (after
 * `<head>`, else after `<html>`, else prepended) so it runs before any game code.
 */
export function injectPreviewRuntime(html: string, opts: { theme?: PreviewTheme } = {}): string {
  if (html.includes(PREVIEW_RUNTIME_MARKER)) return html;
  const theme: PreviewTheme = opts.theme === "bible" ? "bible" : "default";
  const globals = `<script>window.ARIANTRA_PREVIEW=${JSON.stringify({ theme })};</script>`;
  const runtime = `<script>${escapeForInlineScript(PREVIEW_SDK_BUNDLE)}</script>`;
  const block = `${PREVIEW_RUNTIME_MARKER}${globals}${runtime}`;

  const headMatch = html.match(/<head[^>]*>/i);
  if (headMatch) {
    const idx = headMatch.index! + headMatch[0].length;
    return html.slice(0, idx) + block + html.slice(idx);
  }
  const htmlMatch = html.match(/<html[^>]*>/i);
  if (htmlMatch) {
    const idx = htmlMatch.index! + htmlMatch[0].length;
    return html.slice(0, idx) + block + html.slice(idx);
  }
  return block + html;
}
