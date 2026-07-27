// Emails a parent-PIN set/reset code via the platform's mailer — Ari has no
// SMTP of its own. Same server-to-server contract as sparks-bridge.ts:
// x-admin-secret header, the platform decides how (SMTP/dev-log) to actually
// send. BUG-FIX-LOG 2026-07-27.

const PLATFORM_BASE = process.env.ARIANTRA_API_BASE ?? "https://studio.ariantra.com";
const TIMEOUT_MS = 8000;

/** Fails closed to `false` on any transport problem — the caller must treat
 *  that as "the code was never delivered," never as a silent success. */
export async function sendParentPinOtpEmail(email: string, code: string): Promise<boolean> {
  const secret = process.env.AUTH_JWT_SECRET ?? "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${PLATFORM_BASE}/api/studio/partner/parent-pin-otp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-secret": secret },
      body: JSON.stringify({ email, code }),
      signal: controller.signal,
    });
    if (!res.ok) console.error(`[parent-pin-otp-bridge] send rejected (${res.status})`);
    return res.ok;
  } catch (err) {
    console.error(`[parent-pin-otp-bridge] fetch failed: ${(err as Error).message}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}
