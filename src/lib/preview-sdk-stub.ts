// Preview-only Ariantra SDK stub (BUG-FIX-LOG 2026-07-20, "multiplayer game
// never loads in the preview").
//
// CONTRACT: multiplayer-prompt.ts rule 9 promises the game that `Ariantra`
// always exists — "in the preview and on the published page alike" — and
// forbids the game from stubbing it itself. The platform keeps that promise
// on published/invite pages by loading the real SDK before game code; Ari's
// sandboxed preview iframe is the ONLY surface where nobody did, so a
// rule-following game threw ReferenceError at load (load_error) and the
// repair loop chased a correct game forever.
//
// This stub simulates a SOLO SESSION (owner decision 2026-07-20, "waiting
// for host" UAT): the kid is player 1 and host, so the game STARTS and every
// change is instantly playable alone — a game stuck on its waiting screen in
// the preview taught kids their game was broken. Real 2+ player behavior is
// tested via 🎮 Invite / Publish, where the platform's real SDK + lobby own
// the session. Peer-facing calls stay inert: broadcasts are no-ops,
// getPeerState is null, onMessage never fires. Injected ONLY into the
// preview srcDoc (ArtifactFrame), NEVER into published html — publish/invite
// send state.currentHtml untouched, where the platform's real SDK loads.
// Defensive only-if-undefined so it can never shadow a live SDK.

/** Marker so injection is idempotent (same pattern as the console capture). */
export const PREVIEW_SDK_STUB_MARKER = "<!--ari-preview-sdk-stub-->";

export function buildPreviewSdkStub(): string {
  return `
(function () {
  if (window.Ariantra) return; // a real SDK is present — never shadow it
  // The solo roster: the kid, host of their own preview session. joinedAt 0
  // keeps roster-order spawn math deterministic.
  var SOLO = [{ playerId: "preview-solo", isHost: true, joinedAt: 0, displayName: "You" }];
  var later = window.setTimeout || function (fn) { fn(); };
  window.Ariantra = {
    myPlayerId: function () { return "preview-solo"; },
    // Fires each registered callback once with the solo roster —
    // asynchronously, like the real SDK's session events, so it works no
    // matter where in the script the game registers.
    onPlayers: function (cb) {
      if (typeof cb === "function") later(function () { cb(SOLO.slice()); }, 0);
    },
    onMessage: function () {}, // no peers — never fires
    broadcast: function () {},
    broadcastState: function () {},
    getPeerState: function () { return null; },
    // Games are told never to call these (the platform's lobby owns them);
    // harmless no-ops in case one slips through — never a crash.
    host: function () { return Promise.resolve(null); },
    join: function () { return Promise.resolve(null); }
  };
})();
`.trim();
}

/** Adds the stub before any game code, only for games that reference the
 *  SDK at all — single-player html passes through byte-identical. Same
 *  injection anchors as injectConsoleCapture (head → html → prepend). */
export function injectPreviewSdkStub(html: string): string {
  if (html.includes(PREVIEW_SDK_STUB_MARKER)) return html;
  if (!html.includes("Ariantra")) return html;
  const script = `${PREVIEW_SDK_STUB_MARKER}<script>${buildPreviewSdkStub()}</script>`;

  const headMatch = html.match(/<head[^>]*>/i);
  if (headMatch) {
    const idx = headMatch.index! + headMatch[0].length;
    return html.slice(0, idx) + script + html.slice(idx);
  }
  const htmlMatch = html.match(/<html[^>]*>/i);
  if (htmlMatch) {
    const idx = htmlMatch.index! + htmlMatch[0].length;
    return html.slice(0, idx) + script + html.slice(idx);
  }
  return script + html;
}
