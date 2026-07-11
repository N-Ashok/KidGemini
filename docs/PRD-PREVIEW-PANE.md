# PRD — Game Preview Pane (one-pager)

2026-07-11 · Status: implemented · Owner: kidgemini

## What the preview pane is today

`ArtifactFrame` (`src/components/ArtifactFrame.tsx`) renders the kid's generated
game in a sandboxed iframe (`sandbox="allow-scripts"` only — hard security rule)
with Preview / Code tabs, a device switcher (Fit · Laptop · Tablet · Phone), the
Arcade publish CTA, and the self-healing verify cover
(`PRD-SELF-HEALING-PREVIEW.md`). Layout (`ChatPanel.container.tsx`): on mobile a
full-screen overlay (`fixed inset-0 z-[110]`, above the `.ar-nav` at z-100); on
desktop a static 440 px right-hand column beside the chat.

Games are one self-contained HTML blob per assistant message
(`ChatMessage.artifactHtml`), persisted in localStorage (`kidgemini:chats:v1`).
There is no draft/current split — history *is* the version store.

## New in this change

### 1. Full-screen preview (desktop)

- **Ask:** the kid can expand the preview to fill the screen to play
  comfortably, then come back to exactly the split view they had.
- A ⤢ button in the pane header (md+ only — mobile is already full-screen)
  toggles the panel wrapper between the 440 px column and `fixed inset-0
  z-[110]`. **Esc** also collapses.
- **Design decision — CSS-only toggle:** only the wrapper `className` changes
  (`panelShellClass(expanded)` in `src/lib/preview-pane.ts`). The React subtree
  — and therefore the iframe — never remounts, so the running game, tab,
  device choice, and verify state all survive expand/collapse untouched.
  "Come back to the same view" is structural, not restored state.
- The toggle is disabled while the verify cover is up (same reason as the
  device switcher: probes must measure the game at a stable panel size).
- Expanded state resets when the panel is closed (✕ / new chat / switch chat).

### 2. Old game stays playable while an update generates

- **Ask:** while the kid asks for a new feature, the previous version of the
  game stays visible and playable; the new version appears in the preview only
  when it's done (and has passed the verify pass).
- This was already mostly true — `artifact` state is not cleared on send, and
  the new HTML only lands on the stream's `done` event. Two gaps closed:
  1. **Regenerate no longer blanks the panel** (`setArtifact(null)` removed) —
     the old game keeps running until the redo arrives.
  2. **An "update in progress" strip** now shows on the pane while a reply is
     streaming ("✨ Making your update… you can keep playing this one!"), so
     the old game on screen reads as deliberate, not stale.
- Artifact-swap policy is centralized and unit-tested in
  `nextArtifact(event, current)` (`src/lib/preview-pane.ts`): `done` with HTML →
  swap; `done` without → keep; `regenerate`/`send` → keep; safety `retract` →
  clear (fail closed — safety always wins over continuity).

## Non-goals

- No change to the self-healing verify loop, sandbox flags, or publish flow.
- No native `requestFullscreen()` — browser fullscreen needs permission UX and
  breaks the "same view" guarantee; CSS expansion is enough.
- Mobile keeps its existing full-screen overlay + ← Chat pattern.

## Scale ceilings

None new — pure client-side UI over existing state. localStorage blob-per-message
ceiling is unchanged (tracked as TECH_DEBT #26, server-side history).

## Bugs found while implementing (both fixed — BUG-FIX-LOG 2026-07-11)

1. **Verify restarted on every new ask:** `usePreviewVerify`'s effect depended
   on `originalRequest`, so sending a message re-covered and re-verified the
   unchanged old game (and could spend repair calls). Deps are now `[html]`;
   the request rides in a ref.
2. **Updated games never reached the iframe** when the previous verify ended
   without a round bump: `round` resets per controller, so v1 and v2 could
   share round 1 and the srcDoc memo / iframe key never changed — the cover
   hung, then the OLD game was still there. Doc identity is now
   `previewDocKey(generation, round)`. This was the likely cause of "the
   update doesn't show up" reports.

## Tests

`src/lib/preview-pane.test.ts` (framework-free lib, repo pattern — no
@testing-library installed): shell classes for both states incl. the z-[110]
regression pin, Esc-to-collapse mapping, the full `nextArtifact` policy table,
and the `previewDocKey` collision pin. Browser-level:
`scripts/e2e-preview-pane.mjs` (10 checks — see its header for prereqs).
See REGRESSION-TEST-CATALOG.md.
