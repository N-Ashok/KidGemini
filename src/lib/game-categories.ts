// Catalog categories a kid can publish into (owner ask 2026-07-18: "they
// should choose a category and not arcade"). Kept in sync BY HAND with the
// platform's GAME_CATEGORIES (Ariantra-Platform
// src/lib/studio/studio-policy.ts) — the same no-shared-npm-package
// duplication class as the share copy (platform TECH_DEBT #57); the platform
// validates again server-side, so drift fails loud there, not silently here.
// 'Arcade' retired 2026-07-26 (owner decision — it had become the everything
// bucket); the platform rejects it server-side too.
export const GAME_CATEGORIES = [
  "Puzzle",
  "Action",
  "Adventure",
  "Strategy",
  "Casual",
  "Racing",
  "Educational",
  "Other",
] as const;

export type GameCategory = (typeof GAME_CATEGORIES)[number];
