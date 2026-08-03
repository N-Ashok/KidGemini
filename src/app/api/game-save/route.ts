// Save & continue building, Phase 1 backend only
// (docs/2026-08-01_PRD_SaveContinueBuilding.md §3e) — no client wires this
// up yet (ArtifactFrame integration is a later phase).
// PUT  /api/game-save { conversationId, messageId, state } → upsert, scoped
//      to this request's identity (same scheme as /api/chats).
// GET  /api/game-save?messageId= → the saved state, 404 unless it belongs to
//      this request's identity (fail closed, same as GET /api/chats/:id).

import { NextRequest, NextResponse } from "next/server";
import { SqliteGameSaveStore } from "@/lib/db";
import { resolveChatUser } from "@/lib/chat-identity";
import { sanitizeGameSaveState } from "@/lib/game-save";
import { MAX_STATE_JSON_BYTES } from "@/lib/game-save.config";

export const runtime = "nodejs";

const store = new SqliteGameSaveStore();
const MAX_ID = 100;

function isValidId(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_ID;
}

export async function PUT(req: NextRequest) {
  const userId = await resolveChatUser(req);
  if (!userId) return NextResponse.json({ error: "no_identity" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    conversationId?: unknown;
    messageId?: unknown;
    state?: unknown;
  };
  if (!isValidId(body.conversationId) || !isValidId(body.messageId)) {
    return NextResponse.json({ error: "invalid_ids" }, { status: 400 });
  }

  // Size-checked BEFORE full validation so an oversized payload gets its own
  // typed error (PRD §6) rather than being folded into "invalid_state".
  if (JSON.stringify(body.state ?? {}).length > MAX_STATE_JSON_BYTES) {
    return NextResponse.json({ error: "state_too_large" }, { status: 413 });
  }

  const state = sanitizeGameSaveState(body.state);
  if (!state) return NextResponse.json({ error: "invalid_state" }, { status: 400 });

  const written = store.upsert(userId, { conversationId: body.conversationId, messageId: body.messageId, state }, Date.now());
  return NextResponse.json({ ok: true, written });
}

export async function GET(req: NextRequest) {
  const messageId = req.nextUrl.searchParams.get("messageId");
  if (!isValidId(messageId)) return NextResponse.json({ error: "invalid_ids" }, { status: 400 });

  const userId = await resolveChatUser(req);
  if (!userId) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const record = store.get(userId, messageId);
  if (!record) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ state: record.state, updatedAt: record.updatedAt });
}
