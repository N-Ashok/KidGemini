// Shared chrome navigation types. The mobile tab bar's contents are a DECISION
// (which destinations belong to the surface you're on), so they live as pure
// data in src/lib/nav-tabs.ts rather than as JSX in ArNav — a component in a
// node-environment test suite can't be rendered, but a pure function can be
// attacked directly.

export interface NavTab {
  /** Stable id — what tests and analytics key on, independent of the label. */
  id: "chat" | "arcade" | "toybox" | "parent";
  href: string;
  label: string;
  /** Rendered aria-hidden; decoration only. */
  icon: string;
}

/** Which product surface the user is currently inside. Derived from the path,
 *  because the tab bar renders in the shared header above every page. */
export type NavSurface = "kid" | "bible-teacher";
