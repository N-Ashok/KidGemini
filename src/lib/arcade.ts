// "Put it in the Arcade" — pure helpers (no Next imports, unit-tested plain).

/** Derive a platform-valid subdomain slug from a kid-typed game name.
 *  Mirrors the platform's slug charset (^[a-z0-9-]{2,40}$). '' = not derivable. */
export function nameToSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/['’]/g, "") // "Agilan's" → "agilans", not "agilan-s"
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
    .replace(/-$/, "");
  return slug.length >= 2 ? slug : "";
}
