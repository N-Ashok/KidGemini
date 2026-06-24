// Guest usage gate — tunables only (Open/Closed: change limits here, not at call sites).
// A signed-out "guest" may use the app up to GUEST_TOKEN_LIMIT total tokens (chat + safety,
// prompt + output) before /api/chat requires Google sign-in. Signed-in users are unlimited.

/** Total tokens a guest may spend before the sign-in wall. */
export const GUEST_TOKEN_LIMIT = 10_000;

/** Cookie that identifies an anonymous device so its usage can be tallied server-side. */
export const GUEST_COOKIE = "kg_guest";

/** How long the guest identity persists (also the gate's memory window). */
export const GUEST_COOKIE_MAX_AGE_S = 60 * 60 * 24 * 365; // 1 year
