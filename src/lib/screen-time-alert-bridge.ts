// Emails a parent the "daily screen-time cap reached" alert via the
// platform's mailer — Ari has no SMTP of its own. Same server-to-server
// contract as parent-pin-otp-bridge.ts/sparks-bridge.ts: x-admin-secret
// header, the platform decides how (SMTP/dev-log) to actually send.
// Feature 4 (2026-07-28): the heartbeat route calls this fire-and-forget
// (never awaited) — this module's own await/catch is for ITS internal fetch,
// not a promise the caller is required to wait on.
//
// Redesigned 2026-08-08 (docs/BUG-FIX-LOG.md "parent-PIN OTP false
// no-email", same fix class): sends a `playerId`, NOT a plaintext
// parentEmail. Ari cannot reliably know the account's contact email itself —
// a username/password login's SSO session carries no `email` claim — so the
// OLD contract silently dropped this alert for exactly those families, with
// no error ever surfaced (the caller is fire-and-forget). The platform now
// resolves the contact email server-side.

const PLATFORM_BASE = process.env.ARIANTRA_API_BASE ?? "https://studio.ariantra.com";
const TIMEOUT_MS = 8000;

export type SendScreenTimeAlertResult = { ok: true } | { ok: false; error: "no_email" | "send_failed" };

/** Fails closed to `{ok:false, error:'send_failed'}` on any transport
 *  problem — the caller must treat that as "the alert was never delivered,"
 *  never as a silent success. The in-app parent-tab alert (SqliteAlertStore,
 *  unchanged by this feature) already fired regardless of this call's
 *  outcome — so a failed/no-email send here never hides the cap-crossed
 *  event from a parent who checks the app. */
export async function sendScreenTimeAlertEmail(
  playerId: string,
  childLabel: string,
  activeMinutes: number,
  capMinutes: number,
): Promise<SendScreenTimeAlertResult> {
  const secret = process.env.AUTH_JWT_SECRET ?? "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${PLATFORM_BASE}/api/studio/partner/screen-time-alert`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-secret": secret },
      body: JSON.stringify({ playerId, childLabel, activeMinutes, capMinutes }),
      signal: controller.signal,
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (res.ok && data.ok === true) return { ok: true };
    if (res.ok && data.ok === false && data.error === "no_email") return { ok: false, error: "no_email" };
    console.error(`[screen-time-alert-bridge] send rejected (${res.status})`);
    return { ok: false, error: "send_failed" };
  } catch (err) {
    console.error(`[screen-time-alert-bridge] fetch failed: ${(err as Error).message}`);
    return { ok: false, error: "send_failed" };
  } finally {
    clearTimeout(timer);
  }
}
