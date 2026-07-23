/**
 * Where does the "sign in" wall send the user? (SSO — the central login lives
 * on the platform's Studio surface, a DIFFERENT origin from this chat app.)
 *
 * This MUST be decided from the host we're actually served from at click time,
 * NOT from build-time `process.env.NODE_ENV`. A locally-served PRODUCTION build
 * (`next start`) has `NODE_ENV === "production"` yet is still served from
 * localhost — keying off NODE_ENV sent that user to `studio.ariantra.com` and,
 * because prod's `safeReturnTo` rejects a localhost returnTo, stranded them
 * there with their local draft lost (KNOWN_BUGS — 2026-07-23 login-origin bug).
 *
 * Precedence: explicit env override → localhost → production.
 * In dev, the platform login is the platform's :3000, even though this chat app
 * runs on :3001 — so localhost maps to :3000, not same-origin.
 */

const PLATFORM_DEV_LOGIN = "http://localhost:3000/login";
const PLATFORM_PROD_LOGIN = "https://studio.ariantra.com/login";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Resolve the central-login base URL.
 *
 * @param hostname  the host serving THIS app right now (e.g. `window.location.hostname`);
 *                  `undefined` on the server (SSR) — treated as production.
 * @param envOverride  `NEXT_PUBLIC_ARIANTRA_LOGIN_URL` if set — always wins (used
 *                     to point local prod-build testing at a specific platform).
 */
export function resolveLoginUrl(
  hostname: string | undefined,
  envOverride?: string,
): string {
  if (envOverride) return envOverride;
  if (hostname && LOCAL_HOSTS.has(hostname)) return PLATFORM_DEV_LOGIN;
  return PLATFORM_PROD_LOGIN;
}

/** The adult age-gate lives beside login on the same platform host. */
export function ageUrlFrom(loginUrl: string): string {
  return loginUrl.replace(/\/login$/, "/age");
}
