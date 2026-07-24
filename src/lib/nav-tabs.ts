// What the mobile tab bar offers, per surface. Pure data + rules, no React —
// on a phone this bar IS the navigation (the desktop menu is hidden), so
// "which tabs exist here" is a product decision worth testing directly rather
// than burying in ArNav's JSX.
//
// 2026-07-24 (owner report, /bible-teacher on mobile):
//   - Arcade sent teachers to the general kid catalog; it must land on the
//     Bible games listing instead.
//   - Parent area was offered on the teacher surface, where it means nothing
//     (it is the kid-safety/screen-time console, PIN-gated for a child's
//     guardian — a Sunday-school teacher authoring a lesson has no child
//     account behind it).

import type { NavSurface, NavTab } from "@/types/nav.types";

/** Path prefix that owns the Bible-teacher surface. */
const BIBLE_TEACHER_PATH = "/bible-teacher";

/** Which product surface a path belongs to. Exact match or a true sub-path —
 *  a lookalike like /bible-teachers-guide must NOT count. */
export function surfaceFor(pathname: string): NavSurface {
  if (pathname === BIBLE_TEACHER_PATH) return "bible-teacher";
  if (pathname.startsWith(`${BIBLE_TEACHER_PATH}/`)) return "bible-teacher";
  return "kid";
}

/**
 * The tabs to render for `pathname`. Both catalog URLs are injected because
 * they are environment-aware, and that choice belongs to the component.
 *
 * `bibleGamesUrl` is passed SEPARATELY rather than derived as
 * `${gamesUrl}/bible-games` — in dev the catalog lives at
 * `localhost:3000/catalog` while Bible games live at `localhost:3000/bible-games`,
 * so concatenating produces a 404 that only shows up locally.
 */
export function mobileTabs(pathname: string, gamesUrl: string, bibleGamesUrl: string): NavTab[] {
  const surface = surfaceFor(pathname);
  const isBible = surface === "bible-teacher";

  const tabs: NavTab[] = [
    {
      id: "chat",
      // Stay on the surface you are on — a teacher tapping "Chat" and landing
      // on the kid home would have no way back from a phone.
      href: isBible ? BIBLE_TEACHER_PATH : "/",
      label: "Chat",
      icon: "💬",
    },
    { id: "arcade", href: isBible ? bibleGamesUrl : gamesUrl, label: "Arcade", icon: "🎮" },
    // "Game Stuff" gallery (PRD-3D-GAMES-AND-ASSETS §9b): discovery IS the
    // feature — an invisible library never gets asked for. Persona-neutral.
    { id: "toybox", href: "/assets", label: "Toy Box", icon: "🧰" },
  ];

  // Parent area is the kid-safety console; it has no meaning for a teacher
  // authoring lessons, so it is absent rather than disabled.
  if (!isBible) {
    tabs.push({ id: "parent", href: "/parent", label: "Parent", icon: "👪" });
  }

  return tabs;
}

/** Whether a tab should render as the active one. */
export function isTabActive(tab: NavTab, pathname: string): boolean {
  return tab.href === pathname;
}
