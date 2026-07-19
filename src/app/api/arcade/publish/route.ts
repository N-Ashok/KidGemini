export const dynamic = "force-dynamic";
/**
 * [api/arcade/publish] POST — "🚀 Put it in the Arcade" (kid publishes their
 * generated game to games.ariantra.com). Two gates, fail-closed:
 *   1. The SSO `ariantra_session` cookie must verify — the game publishes
 *      under the family's Ariantra account. Signed out → 401 (UI offers
 *      "Sign in with Google").
 *   2. A PIN-verified parent-session cookie (ari_parent) whose account
 *      MATCHES the SSO session — a grown-up of THIS family approves putting
 *      the game on the public internet. The ownership match (not the PIN
 *      itself) is what stops any parent approving any kid's publish
 *      (PRD-PARENT-AUTH-ALERT-SCOPING §8 Phase 1).
 * The raw session token is then forwarded to the platform's partner endpoint
 * (server-to-server, guarded by the shared AUTH_JWT_SECRET), which creates +
 * publishes the game — auto-score, leaderboard, SEO, thumbnail all included.
 *
 * Bodies:  { check: true, name }                → { free, slug, suggestions }
 *          { name, html }                       → { url, slug }
 */

import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifyAriantraSession } from "@/lib/ariantra-session";
import { getVerifiedParentAccount } from "@/lib/parent-session.server";
import { nameToSlug } from "@/lib/arcade";
import { partner } from "@/lib/arcade-partner";
import { MULTIPLAYER_MARKER } from "@/lib/multiplayer-gate";
import { GAME_CATEGORIES } from "@/lib/game-categories";

interface Body {
  check?: boolean;
  list?: boolean;
  name?: string;
  html?: string;
  /** Explicit target slug (update picker) — otherwise derived from name. */
  slug?: string;
  /** Catalog category the kid picked (validated against GAME_CATEGORIES). */
  category?: string;
  /** Kid's explicit single/multiplayer choice (default single = absent/false). */
  multiplayer?: boolean;
}

const SLUG_RE = /^[a-z0-9-]{2,40}$/;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json().catch(() => ({}))) as Body;

  // "Update one of mine" picker: the kid's own games from the platform.
  if (body.list === true) {
    const sessionToken = cookies().get(SESSION_COOKIE)?.value ?? "";
    if (!sessionToken) return NextResponse.json({ error: "signed_out" }, { status: 401 });
    const { status, data } = await partner({ list: true, sessionToken });
    return NextResponse.json(data, { status });
  }

  const name = (body.name ?? "").trim().slice(0, 60);
  // Explicit slug (update picker) wins over name derivation — validated to
  // the platform slug charset so nothing weird rides through.
  const slug = body.slug && SLUG_RE.test(body.slug) ? body.slug : nameToSlug(name);
  if (!slug) {
    return NextResponse.json({ error: "Pick a name with some letters or numbers in it 🙂" }, { status: 422 });
  }

  // Availability check — no gates needed (harmless, and the kid is still
  // typing). The session rides along so the platform can answer "that taken
  // name is YOUR game" → the UI offers Update instead of a rename.
  if (body.check === true) {
    const sessionToken = cookies().get(SESSION_COOKIE)?.value ?? "";
    const { status, data } = await partner({ check: true, slug, ...(sessionToken ? { sessionToken } : {}) });
    return NextResponse.json({ slug, ...data }, { status });
  }

  // Gate 1: signed-in family account (SSO cookie) — verified here for a fast
  // friendly 401, and verified AGAIN by the platform (its own fail-closed check).
  const secret = process.env.AUTH_JWT_SECRET ?? "";
  const rawSession = cookies().get(SESSION_COOKIE)?.value ?? "";
  const session = secret ? await verifyAriantraSession(rawSession, secret) : null;
  if (!session) {
    return NextResponse.json({ error: "signed_out" }, { status: 401 });
  }

  // Gate 2: a PIN-verified parent of THIS family. The account match is the
  // actual fix for "any parent can approve any kid's publish" — a parent
  // session from family A can never approve family B's game.
  const parentAccount = await getVerifiedParentAccount();
  if (!parentAccount || parentAccount !== session.userId) {
    return NextResponse.json({ error: "parent_required" }, { status: 403 });
  }

  if (!body.html || !/<\w+[\s>/]/.test(body.html)) {
    return NextResponse.json({ error: "That game looks empty — generate it again and retry." }, { status: 422 });
  }

  // Multiplayer flag (owner UAT 2026-07-18: published game had "no way to
  // start the multiplayer game", then "the kid need to choose single/multi,
  // default single"): the platform injects its lobby overlay only when
  // seo.multiplayer is true. It takes BOTH the kid's explicit choice in the
  // publish dialog AND the USES_MULTIPLAYER marker actually being in the
  // HTML — choice alone would ship a dead lobby on a single-player game,
  // marker alone would override the kid saying "single player". Only ever
  // sent as true: omitting it leaves an already-flagged game on (the
  // platform treats absent as "no change").
  const multiplayer = body.multiplayer === true && body.html.includes(MULTIPLAYER_MARKER);
  // Category chosen in the publish dialog; unknown values are dropped (the
  // platform keeps its own default) so a stale client can't block a publish.
  const category =
    typeof body.category === "string" && (GAME_CATEGORIES as readonly string[]).includes(body.category)
      ? body.category
      : undefined;
  const { status, data } = await partner({
    sessionToken: rawSession,
    name,
    slug,
    files: { "index.html": { data: body.html, encoding: "utf8" } },
    ...(category ? { category } : {}),
    ...(multiplayer ? { seo: { multiplayer: true } } : {}),
  });
  return NextResponse.json({ slug, ...data }, { status });
}
