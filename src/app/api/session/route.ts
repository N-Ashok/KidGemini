export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// [api/session] GET — who am I? Verifies the shared ariantra_session cookie
// and returns the public identity (or user:null). Client hook useSession()
// polls this once per mount; never cached.

import { NextResponse } from "next/server";
import { getAriantraSession } from "@/lib/ariantra-session.server";

export async function GET(): Promise<NextResponse> {
  const session = await getAriantraSession();
  return NextResponse.json(
    {
      user: session
        ? {
            name: session.name ?? null,
            email: session.email ?? null,
            // Verified-adult claim (PRD-BIBLE-TEACHER) so the client can match
            // the server: the Bible-games publish affordance (fixed category,
            // separate listing) is only shown when the game will ACTUALLY be
            // tagged — which the partner-publish route gates on this same claim.
            adult: session.adult === true,
          }
        : null,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
