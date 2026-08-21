/**
 * RETIRED models: still RESOLVABLE, never OFFERED.
 *
 * The middle setting between "in the library" and "deleted", and the one
 * rule 11 actually asks for — keep the old path as a fallback rather than
 * removing it. A retired name:
 *
 *   • stays in manifest.json, so `injectAssets` resolves it exactly as before
 *     and a game already built on it keeps working forever;
 *   • is kept by selectModelNames rule 1 when the CURRENT game's artifact
 *     already references it, so an edit turn cannot strip a child's own model
 *     out from under them;
 *   • is removed from everything that OFFERS a model to someone — the
 *     retrieval catalogue Ari picks from, the genre spread, and the kid-facing
 *     "Game Stuff" gallery.
 *
 * Deleting the name outright would have done the opposite: published games
 * silently lose the model on their next edit, because injectAssets drops an
 * unknown name fail-soft with no error.
 *
 * WHY EACH ONE IS HERE. Keep this list short and always say what replaces it —
 * a retired model with no successor is a capability the library quietly lost.
 */

/** name → why it was retired, and what should be used instead. */
export const RETIRED_MODELS: Readonly<Record<string, string>> = {
  bird:
    "2026-08-20: no rig and no animation clips at all (skins=0, animations=[]), " +
    "so it could never move however the game code asked — and it reads as a legless " +
    "fish: wings fused flat to the body, no feet, a stray green blob on the head. " +
    "Owner, 2026-08-21: 'lets ari create a new bird and not use this.' No CC0 rigged " +
    "bird worth shipping was found (~110 candidates probed for animations[]; the only " +
    "flying CC0 hits were monster rigs), so the successor is a bird Ari builds in code. " +
    "Two published games (sky-patrol-bridge-city, amala-3d-fruit-treat-catcher) still " +
    "reference it, which is exactly why the name resolves rather than disappearing.",
};

export const RETIRED: ReadonlySet<string> = new Set(Object.keys(RETIRED_MODELS));

/** Manifest model names minus the retired ones — what may be OFFERED. */
export function offerable(names: readonly string[]): string[] {
  return names.filter((n) => !RETIRED.has(n));
}
