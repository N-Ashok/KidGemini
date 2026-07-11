// POST /api/parent/pin — set or reset the family PIN. Requires a FRESH SSO
// session (iat ≤ 5 min): the kid holding a parent's live-but-old session must
// not reach this; the client redirects through the platform login first (§7).
// A successful set also issues the parent-session cookie — the parent who
// just set a PIN shouldn't have to immediately retype it.
// PRD-PARENT-AUTH-ALERT-SCOPING §7/§8, D6. AUTH CODE — fail closed.

import { NextRequest, NextResponse } from "next/server";
import { getAriantraSession } from "@/lib/ariantra-session.server";
import { isFreshSession } from "@/lib/ariantra-session";
import { SqliteParentAuthStore } from "@/lib/db";
import { hashPin, isValidPinFormat } from "@/lib/parent-pin";
import {
  mintParentSession,
  parentSessionCookieAttrs,
  PARENT_SESSION_COOKIE,
} from "@/lib/parent-session";

export const runtime = "nodejs";

const store = new SqliteParentAuthStore();

export async function POST(req: NextRequest) {
  const session = await getAriantraSession();
  if (!session) {
    return NextResponse.json({ error: "signed_out" }, { status: 401 });
  }
  if (!isFreshSession(session, Date.now())) {
    // Client shows "sign in again to continue" → platform login round-trip.
    return NextResponse.json({ error: "stale_session" }, { status: 403 });
  }

  let pin: unknown;
  try {
    ({ pin } = await req.json());
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (typeof pin !== "string" || !pin) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!isValidPinFormat(pin)) {
    return NextResponse.json(
      { error: "invalid_pin", message: "Pick 4 digits that aren't an easy pattern." },
      { status: 422 },
    );
  }

  // Set and reset are the same write — the fresh-session gate above is the
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
