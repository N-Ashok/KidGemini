// POST /api/parent/pin-otp/request — emails a 6-digit code that proves the
// caller can read the family account's mail. POST /api/parent/pin then
// requires it instead of the old "fresh SSO session" gate (BUG-FIX-LOG
// 2026-07-27: a shared family device can pass a login-freshness check with
// no secret only the parent has — a live Google session or a saved password
// clears it — so a kid locked out of guessing the PIN could just reset it;
// the OTP is a real second factor).
//
// Redesigned 2026-08-08 (docs/BUG-FIX-LOG.md "parent-PIN OTP false
// no-email"): no longer gates on `session.email`. A username/password
// login's SSO session never carries that claim (the account's email is
// stored only as a one-way hash for privacy) — gating on it here reported
// "no email on file" for accounts that genuinely had a verified contact
// email, they just weren't currently signed in via Google. The bridge now
// resolves the real address server-side by `session.playerId`; this route
// only forwards its structured result (`ok`, `no_email`, `send_failed`).
// AUTH CODE — fail closed.

import { NextResponse } from "next/server";
import { getAriantraSession } from "@/lib/ariantra-session.server";
import { SqliteParentPinOtpStore } from "@/lib/db";
import { canRequestOtp, generateOtpCode, nextOtpRecord } from "@/lib/parent-pin-otp";
import { sendParentPinOtpEmail } from "@/lib/parent-pin-otp-bridge";

export const runtime = "nodejs";

const store = new SqliteParentPinOtpStore();

export async function POST(req: Request) {
  const session = await getAriantraSession();
  if (!session) {
    return NextResponse.json({ error: "signed_out" }, { status: 401 });
  }

  const now = Date.now();
  const existing = store.get(session.userId);
  const gate = canRequestOtp(existing, now);
  if (!gate.ok) {
    return NextResponse.json({ error: gate.reason, retryAt: gate.retryAt }, { status: 429 });
  }

  // Hotfix 2026-08-08: the parent may be supplying a contact address for the
  // FIRST time, straight from the PIN screen, because the platform holds none
  // (32 of 50 registered accounts were in that state and could not set a PIN
  // at all). Optional — an account that already has an address ignores it.
  const body = (await req.json().catch(() => ({}))) as { email?: unknown };
  const firstContactEmail = typeof body.email === "string" ? body.email.trim() : undefined;

  const code = generateOtpCode();
  const record = nextOtpRecord(session.userId, code, existing, now);

  const result = await sendParentPinOtpEmail(session.playerId, code, firstContactEmail || undefined);
  if (!result.ok) {
    if (result.error === "no_email") {
      // A genuine gap, not the bug this fix closes: the account truly has no
      // owner-profile contact email saved anywhere on the platform. Point
      // somewhere actionable instead of a dead "contact support".
      return NextResponse.json(
        {
          error: "no_email",
          // `needsEmail` is what turns a dead end into a next step: the PIN
          // screen shows an address field instead of an apology.
          needsEmail: true,
          message: "We don't have a parent email for this account yet — add one below and we'll send the code there.",
        },
        { status: 422 },
      );
    }
    return NextResponse.json(
      { error: "send_failed", message: "Couldn't send the email — try again in a moment." },
      { status: 502 },
    );
  }
  // Only persist once the send actually succeeded — a failed send must not
  // burn a resend-cooldown/daily-cap slot the parent never got any benefit from.
  store.put(record);

  return NextResponse.json({
    ok: true,
    maskedEmail: result.maskedEmail,
    expiresInSeconds: Math.floor((record.expiresAt - now) / 1000),
  });
}
