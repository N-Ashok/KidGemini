// POST /api/parent/verify-pin — { pin } in the BODY, never a query param.
// Session-bound: the account comes from the SSO session, so a caller can only
// verify against the family they're signed into; guests 401 before any PIN
// logic (D3). Correct PIN → short-lived HttpOnly parent-session cookie; alert
// reads and publish approvals check THAT, never a PIN.
// PRD-PARENT-AUTH-ALERT-SCOPING §8/§9. AUTH CODE — fail closed.

import { NextRequest, NextResponse } from "next/server";
import { getAriantraSession } from "@/lib/ariantra-session.server";
import { SqliteParentAuthStore } from "@/lib/db";
import { verifyPinAttempt } from "@/lib/parent-pin";
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

  let pin: unknown;
  try {
    ({ pin } = await req.json());
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (typeof pin !== "string" || !pin) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const record = store.get(session.userId);
  const { result, update } = verifyPinAttempt(record, pin, Date.now());
  if (record) store.recordAttempt(session.userId, update);

  switch (result.ok ? "ok" : result.reason) {
    case "ok": {
      const secret = process.env.AUTH_JWT_SECRET!; // session verified ⇒ secret exists
      const token = await mintParentSession(session.userId, secret);
      const res = NextResponse.json({ ok: true });
      res.cookies.set(PARENT_SESSION_COOKIE, token, parentSessionCookieAttrs());
      return res;
    }
    case "not-set":
      return NextResponse.json({ error: "not_set" }, { status: 404 });
    case "locked":
      return NextResponse.json(
        { error: "locked", unlockAt: (result as { unlockAt: number }).unlockAt },
        { status: 429 },
      );
    default:
      return NextResponse.json(
        { error: "wrong_pin", attemptsLeft: (result as { attemptsLeft: number }).attemptsLeft },
        { status: 401 },
      );
  }
}
