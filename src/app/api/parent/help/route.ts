// GET /api/parent/help — every help ticket and reply for the signed-in
// parent's own account (docs/PRD-COMMUNITY-HELP.md §3.6).
//
// This is the accountability surface for the whole feature: because a helper is
// an adult writing to a child, a parent must be able to read every word of it
// without opting in to anything (§3.8 constraint 3 — replies also write a
// ParentAlert so they surface in the alerts list itself).
//
// Gated by the same PIN-verified parent-session cookie as /api/alerts. No
// freshness requirement: reading is not a credential change (same posture the
// screen-time PRD settled on).

import { NextRequest, NextResponse } from "next/server";
import { SqliteHelpStore } from "@/lib/db";
import { getVerifiedParentAccount } from "@/lib/parent-session.server";

export const runtime = "nodejs";

const help = new SqliteHelpStore();

export async function GET(_req: NextRequest) {
  const account = await getVerifiedParentAccount();
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const tickets = help.listOwn(account, 100).map((t) => ({
    id: t.id,
    reasonCode: t.reasonCode,
    status: t.status,
    // The child's own words, when they spoke instead of tapping a picture.
    transcript: t.transcript,
    conversationId: t.conversationId,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    replies: t.replies.map((r) => ({
      id: r.id,
      body: r.body,
      createdAt: r.createdAt,
      /** False = an admin typed it by hand. Surfaced so a parent can tell a
       *  reviewed library reply from free text at a glance. */
      canned: r.cannedId !== null,
    })),
  }));

  return NextResponse.json({ tickets });
}
