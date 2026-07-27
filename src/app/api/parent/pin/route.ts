// POST /api/parent/pin — set or reset the family PIN. Requires a valid OTP
// (POST /api/parent/pin-otp/request emails it) proving the caller can read
// the account's own mail. BUG-FIX-LOG 2026-07-27: this REPLACES the old
// "fresh SSO session (iat ≤ 5 min)" gate — that gate re-used the platform
// login, but a live Google browser session (or a saved password) clears it
// with no secret only the parent has, so on a shared family device a kid
// locked out of guessing the PIN could just reset it. A successful set also
// issues the parent-session cookie — the parent who just set a PIN shouldn't
// have to immediately retype it.
// PRD-PARENT-AUTH-ALERT-SCOPING §7/§8, D6. AUTH CODE — fail closed.

import { NextRequest, NextResponse } from "next/server";
import { getAriantraSession } from "@/lib/ariantra-session.server";
import { SqliteParentAuthStore, SqliteParentPinOtpStore } from "@/lib/db";
import { hashPin, isValidPinFormat } from "@/lib/parent-pin";
import { verifyOtpAttempt } from "@/lib/parent-pin-otp";
import {
  mintParentSession,
  parentSessionCookieAttrs,
  PARENT_SESSION_COOKIE,
} from "@/lib/parent-session";

export const runtime = "nodejs";

const store = new SqliteParentAuthStore();
const otpStore = new SqliteParentPinOtpStore();

export async function POST(req: NextRequest) {
  const session = await getAriantraSession();
  if (!session) {
    return NextResponse.json({ error: "signed_out" }, { status: 401 });
  }

  let pin: unknown;
  let otp: unknown;
  try {
    ({ pin, otp } = await req.json());
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (typeof pin !== "string" || !pin || typeof otp !== "string" || !otp) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!isValidPinFormat(pin)) {
    return NextResponse.json(
      { error: "invalid_pin", message: "Pick 4 digits that aren't an easy pattern." },
      { status: 422 },
    );
  }

  const otpRecord = otpStore.get(session.userId);
  const { result: otpResult, updatedAttempts } = verifyOtpAttempt(otpRecord, otp, Date.now());
  if (!otpResult.ok) {
    if (updatedAttempts !== null) otpStore.recordAttempt(session.userId, updatedAttempts);
    switch (otpResult.reason) {
      case "not-requested":
        return NextResponse.json(
          { error: "otp_not_requested", message: "Request a code first." },
          { status: 400 },
        );
      case "expired":
        return NextResponse.json(
          { error: "otp_expired", message: "That code expired — request a new one." },
          { status: 400 },
        );
      case "too-many-attempts":
        return NextResponse.json(
          { error: "otp_too_many_attempts", message: "Too many wrong codes — request a new one." },
          { status: 429 },
        );
      default:
        return NextResponse.json(
          { error: "otp_wrong", attemptsLeft: otpResult.attemptsLeft },
          { status: 401 },
        );
    }
  }
  otpStore.clear(session.userId); // single-use

  // Set and reset are the same write — the OTP just verified is the
  // protection for both. Throttling state clears with the new PIN.
  store.put({
    accountId: session.userId,
    pinHash: hashPin(pin),
    setAt: Date.now(),
    attempts: 0,
    lockedUntil: null,
    lastLockoutAt: null,
  });

  const secret = process.env.AUTH_JWT_SECRET!;
  const token = await mintParentSession(session.userId, secret);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(PARENT_SESSION_COOKIE, token, parentSessionCookieAttrs());
  return res;
}
