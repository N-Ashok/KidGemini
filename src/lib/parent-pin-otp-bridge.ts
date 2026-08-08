// Emails a parent-PIN set/reset code via the platform's mailer — Ari has no
// SMTP of its own. Same server-to-server contract as sparks-bridge.ts:
// x-admin-secret header, the platform decides how (SMTP/dev-log) to actually
// send. BUG-FIX-LOG 2026-07-27.
//
// Redesigned 2026-08-08 (docs/BUG-FIX-LOG.md "parent-PIN OTP false
// no-email"): sends a `playerId`, NOT a plaintext email. Ari cannot reliably
// know the account's contact email itself — a username/password login's SSO
// session carries no `email` claim (the account's email is stored only as a
// one-way hash for privacy) — so the OLD contract silently couldn't send for
// any account that logged in that way, even when the platform had a
// perfectly good verified contact email on file. The platform is the only
// place holding the decryptable address; it resolves it server-side and
// returns only a masked version here — the plaintext never reaches Ari.

const PLATFORM_BASE = process.env.ARIANTRA_API_BASE ?? "https://studio.ariantra.com";
const TIMEOUT_MS = 8000;

export type SendParentPinOtpResult =
  | { ok: true; maskedEmail: string }
  | { ok: false; error: "no_email" | "send_failed" };

/** Fails closed to `{ok:false, error:'send_failed'}` on any transport
 *  problem — the caller must treat that as "the code was never delivered,"
 *  never as a silent success. `{ok:false, error:'no_email'}` is a distinct,
 *  legitimate outcome (the account genuinely has no contact email on file)
 *  the caller should show the parent, not swallow. */
export async function sendParentPinOtpEmail(
  playerId: string,
  code: string,
  /** OPTIONAL address the parent just typed on the PIN screen, forwarded ONLY
   *  when the platform holds none (BUG-FIX-LOG 2026-08-08 hotfix). The platform
   *  ignores it whenever the account already has an address, so it can never
   *  redirect an existing family's codes — see the route's note. */
  firstContactEmail?: string,
): Promise<SendParentPinOtpResult> {
  const secret = process.env.AUTH_JWT_SECRET ?? "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${PLATFORM_BASE}/api/studio/partner/parent-pin-otp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-secret": secret },
      body: JSON.stringify({ playerId, code, ...(firstContactEmail ? { email: firstContactEmail } : {}) }),
      signal: controller.signal,
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; maskedEmail?: string; error?: string };
    if (res.ok && data.ok === true && typeof data.maskedEmail === "string") {
      return { ok: true, maskedEmail: data.maskedEmail };
    }
    if (res.ok && data.ok === false && data.error === "no_email") {
      return { ok: false, error: "no_email" };
    }
    console.error(`[parent-pin-otp-bridge] send rejected (${res.status})`);
    return { ok: false, error: "send_failed" };
  } catch (err) {
    console.error(`[parent-pin-otp-bridge] fetch failed: ${(err as Error).message}`);
    return { ok: false, error: "send_failed" };
  } finally {
    clearTimeout(timer);
  }
}
