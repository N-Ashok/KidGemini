// Guest usage gate — tunables only (Open/Closed: change limits here, not at call sites).
// A signed-out "guest" may use the app up to GUEST_TOKEN_LIMIT total tokens (chat + safety,
// prompt + output) before /api/chat requires Google sign-in. Signed-in users are unlimited.

/** Total tokens a guest may spend WITHIN THE ROLLING WINDOW before the
 *  sign-in wall. Resets naturally as old usage ages out of the window. */
export const GUEST_TOKEN_LIMIT = 10_000;

/** Rolling window for the guest tallies (device AND per-IP): 2 days. */
export const GUEST_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

/** Cookie that identifies an anonymous device so its usage can be tallied server-side. */
export const GUEST_COOKIE = "kg_guest";

/** How long the guest identity persists (also the gate's memory window). */
export const GUEST_COOKIE_MAX_AGE_S = 60 * 60 * 24 * 365; // 1 year

/**
 * IP backstop: total guest tokens allowed per IP, across ALL devices/cookies
 * (defeats cookie-clearing). 2x the device allowance on purpose — families and
 * school networks share IPs; don't punish the second sibling.
 */
export const IP_GUEST_TOKEN_CAP = 20_000;

/**
 * Signed-in daily token budget — the pay funnel's next stage, CONFIG-READY BUT
 * OFF (0 = unlimited). Flip by setting the SIGNED_IN_DAILY_TOKEN_LIMIT env var
 * (e.g. 50000): exceeding it returns HTTP 402 → the upgrade/paywall screen.
 * Read per-request so ops can enable it without a rebuild.
 */
export function signedInDailyTokenLimit(): number {
  const n = Number(process.env.SIGNED_IN_DAILY_TOKEN_LIMIT ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
/** Default surfaced for docs/tests: the budget ships OFF. */
export const SIGNED_IN_DAILY_TOKEN_LIMIT = signedInDailyTokenLimit();
