// Preview pane policy — framework-free so it's unit-testable (repo pattern:
// no @testing-library; logic lives here, components stay presentational).
// PRD: docs/PRD-PREVIEW-PANE.md.

/** Stream/UI moments that may change WHICH game the preview shows. */
export type PreviewPaneEvent =
  | { type: "done"; artifactHtml?: string | null }
  | { type: "retract" }
  | { type: "regenerate" }
  | { type: "send" };

/**
 * The one rule for the preview's contents: the OLD game stays visible and
 * playable until a finished NEW game arrives. Only a safety retract may blank
 * the panel early (fail closed — safety beats continuity).
 */
export function nextArtifact(ev: PreviewPaneEvent, current: string | null): string | null {
  switch (ev.type) {
    case "done":
      return ev.artifactHtml ?? current;
    case "retract":
      return null;
    case "regenerate":
    case "send":
      return current;
  }
}

/**
 * Wrapper classes for the artifact panel. Expanding is a CSS-only toggle on
 * this ONE wrapper — the subtree (and iframe) never remounts, so collapsing
 * returns to exactly the prior view. z-[110] in BOTH states: must sit above
 * the sticky brand nav (.ar-nav, z-100) — BUG-FIX-LOG 2026-07-07.
 */
export function panelShellClass(expanded: boolean): string {
  return expanded
    ? "fixed inset-0 z-[110] bg-white"
    : "fixed inset-0 z-[110] bg-white md:static md:inset-auto md:z-auto md:w-[440px] md:border-l md:border-neutral-200";
}

/** Esc collapses an expanded panel; everything else is left alone. */
export function keyToPanelAction(key: string, expanded: boolean): "collapse" | null {
  return key === "Escape" && expanded ? "collapse" : null;
}

/**
 * Identity of the document the preview iframe should hold. The verify
 * controller's `round` restarts per game, so two DIFFERENT games can carry the
 * SAME round number — keying the iframe/srcDoc on round alone made an updated
 * game never appear (BUG-FIX-LOG 2026-07-11). The generation (bumped per game
 * html) disambiguates; the round still forces the mid-repair/pristine reloads.
 */
export function previewDocKey(generation: number, round: number): string {
  return `${generation}:${round}`;
}

/** Shown on the pane while an update streams — the old game on screen is deliberate. */
export const UPDATING_LINE = "Making your update… you can keep playing this one! ✨";
