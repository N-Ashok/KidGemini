// Shared bridge to the platform's partner-publish endpoint — used by
// api/arcade/publish, api/arcade/test-link, and api/parent/games, which were
// three copy-pasted, near-byte-identical implementations (2026-07-17). None
// of the three guarded the fetch itself: a network failure or hang threw/hung
// unguarded out of the route handler. One shared helper closes the gap once
// instead of three times, and keeps the three routes from drifting apart.

const PLATFORM_BASE = process.env.ARIANTRA_API_BASE ?? "https://studio.ariantra.com";
const PARTNER_TIMEOUT_MS = 8000;

const SECRET_MISMATCH_ERROR =
  "The Arcade server said no — a grown-up should check that kidgemini and the platform share the same secret (and ARIANTRA_API_BASE in local dev).";
const NETWORK_ERROR = "Couldn't reach the Arcade server — try again in a moment.";

export interface PartnerResult {
  status: number;
  data: Record<string, unknown>;
}

/** POSTs to the platform's partner-publish endpoint. Never throws: a network
 *  failure/timeout, and the pre-existing "our secret doesn't match theirs"
 *  case, both come back as a normal PartnerResult the caller can respond with. */
export async function partner(payload: unknown): Promise<PartnerResult> {
  const secret = process.env.AUTH_JWT_SECRET ?? "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PARTNER_TIMEOUT_MS);
  let res: { status: number; json: () => Promise<unknown> };
  try {
    res = await fetch(`${PLATFORM_BASE}/api/studio/partner/publish`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-secret": secret },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    console.error(`[arcade-partner] fetch failed: ${(err as Error).message}`);
    return { status: 502, data: { error: NETWORK_ERROR } };
  } finally {
    clearTimeout(timer);
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  // The partner endpoint 403s ONLY on an x-admin-secret mismatch (operator
  // misconfig: secret drift, or ARIANTRA_API_BASE pointing at the wrong
  // platform). Forwarding it verbatim collided with each route's OWN 403
  // (BUG-FIX-LOG 2026-07-11) — map it to a distinct 502 instead.
  if (res.status === 403) {
    return { status: 502, data: { error: SECRET_MISMATCH_ERROR } };
  }
  return { status: res.status, data };
}
