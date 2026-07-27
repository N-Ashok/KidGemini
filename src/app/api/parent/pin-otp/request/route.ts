// POST /api/parent/pin-otp/request — emails a 6-digit code that proves the
// caller can read the family account's mail. POST /api/parent/pin then
// requires it instead of the old "fresh SSO session" gate (BUG-FIX-LOG
// 2026-07-27: a shared family device can pass a login-freshness check with
// no secret only the parent has — a live Google session or a saved password
// clears it — so a kid locked out of guessing the PIN could just reset it;
// the OTP is a real second factor).
// AUTH CODE — fail closed.

import { NextResponse } from "next/server";
import { getAriantraSession } from "@/lib/ariantra-session.server";
import { SqliteParentPinOtpStore } from "@/lib/db";
import { canRequestOtp, generateOtpCode, nextOtpRecord } from "@/lib/parent-pin-otp";
import { sendParentPinOtpEmail } from "@/lib/parent-pin-otp-bridge";

export const runtime = "nodejs";

const store = new SqliteParentPinOtpStore();

/** "parent@example.com" → "p****@example.com" — enough for the parent to
 *  recognize their own inbox without echoing the full address back. */
function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "your email";
  const user = email.slice(0, at);
  const domain = email.slice(at + 1);
  const masked = user.length <= 1 ? "*" : `${user[0]}${"*".repeat(user.length - 1)}`;
  return `${masked}@${domain}`;
}

export async function POST() {
  const session = await getAriantraSession();
  if (!session) {
    return NextResponse.json({ error: "signed_out" }, { status: 401 });
  }
  if (!session.email) {
    return NextResponse.json(
      { error: "no_email", message: "Your account has no email on file — contact support." },
      { status: 422 },
    );
  }

  const now = Date.now();
  const existing = store.get(session.userId);
  const gate = canRequestOtp(existing, now);
  if (!gate.ok) {
    return NextResponse.json({ error: gate.reason, retryAt: gate.retryAt }, { status: 429 });
  }

  const code = generateOtpCode();
  const record = nextOtpRecord(session.userId, code, existing, now);

  const sent = await sendParentPinOtpEmail(session.email, code);
  if (!sent) {
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
    maskedEmail: maskEmail(session.email),
    expiresInSeconds: Math.floor((record.expiresAt - now) / 1000),
  });
}
