// Catalog categories a kid can publish into (owner ask 2026-07-18: "they
// should choose a category and not arcade"). Since 2026-07-26 the taxonomy
// is ADMIN-EXTENDABLE platform-side (/studio/admin), so this baked list is
// only the OFFLINE FALLBACK: the publish picker fetches the live list via
// /api/arcade/categories (which proxies the platform's public
// /api/categories) and falls back here when that fails. The platform still
// validates every publish server-side, so drift fails loud there, never
// silently here. 'Arcade' retired 2026-07-26 (owner decision — it had become
// the everything bucket); the platform rejects it server-side too.
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

/** Validate a fetched category list. Null = unusable (caller keeps the baked
 *  fallback); otherwise strings only, each ≤ 40 chars, list capped at 40. */
export function sanitizeCategories(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const clean = raw
    .filter((c): c is string => typeof c === "string" && c.length > 0 && c.length <= 40)
    .slice(0, 40);
  return clean.length > 0 ? clean : null;
}
