// Emails a parent the "daily screen-time cap reached" alert via the
// platform's mailer — Ari has no SMTP of its own. Same server-to-server
// contract as parent-pin-otp-bridge.ts/sparks-bridge.ts: x-admin-secret
// header, the platform decides how (SMTP/dev-log) to actually send.
// Feature 4 (2026-07-28): the heartbeat route calls this fire-and-forget
// (never awaited) — this module's own await/catch is for ITS internal fetch,
// not a promise the caller is required to wait on.

const PLATFORM_BASE = process.env.ARIANTRA_API_BASE ?? "https://studio.ariantra.com";
const TIMEOUT_MS = 8000;

/** Fails closed to `false` on any transport problem — the caller must treat
 *  that as "the alert was never delivered," never as a silent success. The
 *  in-app parent-tab alert (SqliteAlertStore, unchanged by this feature)
 *  already fired regardless of this call's outcome — so a failed email here
 *  never hides the cap-crossed event from a parent who checks the app. */
export async function sendScreenTimeAlertEmail(
  parentEmail: string,
  childLabel: string,
  activeMinutes: number,
  capMinutes: number,
): Promise<boolean> {
  const secret = process.env.AUTH_JWT_SECRET ?? "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${PLATFORM_BASE}/api/studio/partner/screen-time-alert`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-secret": secret },
      body: JSON.stringify({ parentEmail, childLabel, activeMinutes, capMinutes }),
      signal: controller.signal,
    });
    if (!res.ok) console.error(`[screen-time-alert-bridge] send rejected (${res.status})`);
    return res.ok;
  } catch (err) {
    console.error(`[screen-time-alert-bridge] fetch failed: ${(err as Error).message}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}
