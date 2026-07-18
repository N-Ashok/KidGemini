// POST /api/chat — the safety boundary, now STREAMING.
// Posture (user-chosen, 2026-07-09): live-stream tokens while Gemini's built-in strict
// safety blocks in real time, with a child-safety system prompt (age 7-14) on every
// generation. The Flash-Lite output monitor was REMOVED — it retracted harmless games
// (chess!) after they had streamed; games must never be blocked by the safety layer.
// Input is still pre-checked with instant deterministic rules (blocks + parent alerts).
// Response is NDJSON: {type:"thinking"|"delta"|"done"|"blocked"|"error", ...}. See CLAUDE.md § 3.

import "@/lib/logger"; // tees all server console output to logs/app.log
import { NextRequest, NextResponse } from "next/server";
import { GeminiChatModel, extractArtifact } from "@/lib/gemini";
import { isGameEditTurn, currentGameHtml, editReplyProse } from "@/lib/game-edit";
import { applyPatch } from "@/lib/repair-prompt";
import { injectAssets } from "@/lib/assets/inject";
import { kidThoughtLine } from "@/lib/kid-thought";
import { trimHistory } from "@/lib/history-trim";
import { RulesClassifier } from "@/lib/safety.rules";
import { SqliteAlertStore, SqliteUsageStore, SqliteRateLimitStore, SqliteTurnResultStore, SqliteScreenTimeStore } from "@/lib/db";
import { resolveGeo } from "@/lib/geo";
import { estimateCostUsd } from "@/lib/pricing.config";
import { getAriantraSession } from "@/lib/ariantra-session.server";
import { GUEST_TOKEN_LIMIT, GUEST_COOKIE, GUEST_COOKIE_LEGACY, GUEST_COOKIE_MAX_AGE_S, GUEST_WINDOW_MS, IP_GUEST_TOKEN_CAP, signedInDailyTokenLimit } from "@/lib/gate.config";
import { validateImageAttachment } from "@/lib/image-attachment";
import type { ChatMessage, ImageAttachment, TokenUsage } from "@/types/chat.types";
import type { SafetyVerdict } from "@/types/safety.types";

export const runtime = "nodejs";

const rules = new RulesClassifier();
const chatModel = new GeminiChatModel();
const alerts = new SqliteAlertStore();
const usage = new SqliteUsageStore();
const rateLimit = new SqliteRateLimitStore();
const turnResults = new SqliteTurnResultStore();

const KIND_REDIRECT =
  "Let's talk about something else! How about a fun fact, a story, or a game? 🌟";

const estTokens = (t: string) => Math.ceil(t.length / 4);

export async function POST(req: NextRequest) {
  const geo = resolveGeo(req);
  let body: { message?: string; history?: ChatMessage[]; image?: unknown; replyId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Resumable generations (TECH_DEBT #23): when the client names its reply
  // message id, the finished result is ALSO kept server-side so a
  // disconnected client can collect it instead of re-generating. Every
  // turn-result write is fail-open — a bookkeeping hiccup never breaks chat.
  const replyId =
    typeof body.replyId === "string" && body.replyId.length > 0 && body.replyId.length <= 100
      ? body.replyId
      : null;
  const trackTurn = (op: () => void) => {
    try {
      op();
    } catch (err) {
      console.warn(`[api/chat] turn-result write failed (ignored): ${(err as Error).message}`);
    }
  };

  const message = (body.message ?? "").trim();
  // Trim what the MODEL sees (stale game versions stripped + sliding window,
  // see history-trim.ts) — the client's stored conversation is untouched.
  const history = trimHistory(body.history ?? []);
  if (!message) return NextResponse.json({ error: "Empty message" }, { status: 400 });

  // Picture upload (context for the model): deterministic guards, fail-closed —
  // a malformed/off-list/oversized image rejects the whole request rather than
  // silently continuing without it (the child would think we saw the picture).
  let image: ImageAttachment | undefined;
  if (body.image !== undefined) {
    const v = validateImageAttachment(body.image);
    if (!v.ok) {
      console.log(`[api/chat] ⛔ image rejected (${v.reason})`);
      return NextResponse.json(
        { error: "bad_image", message: "That picture didn't work — try a photo or screenshot (JPG or PNG). 📷" },
        { status: 400 },
      );
    }
    image = v.image;
  }

  // ── Identity & the guest gate (server-enforced; fail-closed) ──────────────
  // Signed-in users are unlimited and keyed by their Google account. Guests are keyed by an
  // httpOnly device cookie and capped at GUEST_TOKEN_LIMIT total tokens (chat + safety). The
  // client cannot bypass this — the check and the tally both live here on the server.
  const session = await safeAuth();
  const signedIn = Boolean(session);

  // Guest trial (PRD "guest gate", restored): new visitors chat up to
  // GUEST_TOKEN_LIMIT tokens, backstopped per-IP; signed-in users have a
  // config-ready daily budget (OFF by default). EVERY block below travels as
  // an HTTP STATUS the client checks — never only an in-band stream event
  // (silent-hang prevention class, BUG-FIX-LOG 2026-06-25).

  let setGuestCookie: string | null = null;
  let userId: string;
  let userLabel: string | null;

  if (signedIn) {
    userId = session!.userId; // email-first key from the SSO session (pre-SSO row continuity)
    userLabel = session!.name ?? session!.email ?? null;

    // Paid-funnel stage 2 (config-ready, OFF while the env knob is 0): daily budget → 402.
    const dailyLimit = signedInDailyTokenLimit();
    if (dailyLimit > 0) {
      const dayStart = new Date().setUTCHours(0, 0, 0, 0);
      const usedToday = usage.tokensUsedByUserSince(userId, dayStart);
      if (usedToday >= dailyLimit) {
        console.log(`[api/chat] ⛔ daily budget userId=${userId} used=${usedToday}/${dailyLimit} → 402`);
        return NextResponse.json(
          { error: "payment_required", reason: "daily_budget",
            message: "You've used today's free tokens — upgrade to keep chatting, or come back tomorrow! ⭐" },
          { status: 402 },
        );
      }
    }
  } else {
    let guestId = req.cookies.get(GUEST_COOKIE)?.value;
    if (!guestId) {
      // Pre-rename cookie (2026-07-17, "kidgemini" → "Ari") — a returning
      // device's whole identity/history lives behind this cookie for up to
      // a year, so a name change alone would silently reset every existing
      // guest. Found under the old name → same identity, one-time silent
      // migration to the new cookie name (same Set-Cookie path as brand-new
      // below, just a different source for the id).
      guestId = req.cookies.get(GUEST_COOKIE_LEGACY)?.value;
      if (guestId) {
        setGuestCookie = guestId;
      } else {
        guestId = `guest:${crypto.randomUUID()}`;
        setGuestCookie = guestId; // brand-new device — persist the identity on the response
      }
    }
    userId = guestId;
    userLabel = "Guest";

    // Per-IP rate limit (abuse / Gemini-cost control) — guests only; signed-in users are exempt.
    // Runs before the token gate so abusive volume is stopped as cheaply as possible.
    if (geo.ip) {
      const rl = rateLimit.hit(geo.ip, Date.now());
      if (rl.state === "blocked") {
        console.log(`[api/chat] ⛔ rate-limit ip=${geo.ip} until=${rl.until} mustPay=${rl.mustPay}`);
        return rl.mustPay
          ? NextResponse.json(
              { error: "payment_required", reason: "strikes",
                message: "You've hit the free limit a few times now. Sign in and upgrade to keep chatting! 💳" },
              { status: 402, headers: guestCookieHeader(setGuestCookie) },
            )
          : NextResponse.json(
              { error: "rate_limited",
                message: "Whoa, slow down! 🐢 That's a lot of messages — take a short break, or sign in to keep going." },
              { status: 429, headers: guestCookieHeader(setGuestCookie) },
            );
      }

      // IP backstop: cookie-clearing must not reset the trial. Checked BEFORE
      // the per-device tally so a fresh cookie on a spent IP walls immediately.
      // Both tallies are windowed: the trial RESETS as usage ages past 2 days.
      const ipUsed = usage.guestTokensUsedByIp(geo.ip, Date.now() - GUEST_WINDOW_MS);
      if (ipUsed >= IP_GUEST_TOKEN_CAP) {
        console.log(`[api/chat] ⛔ gate: ip=${geo.ip} used=${ipUsed}/${IP_GUEST_TOKEN_CAP} → 401`);
        return NextResponse.json(
          { error: "auth_required", reason: "ip_limit",
            message: "Please sign in to continue using Ari ✨" },
          { status: 401, headers: guestCookieHeader(setGuestCookie) },
        );
      }
    }

    const used = usage.tokensUsedByUser(guestId, Date.now() - GUEST_WINDOW_MS);
    console.log(`[api/chat] guest ${guestId} used=${used}/${GUEST_TOKEN_LIMIT} tokens`);
    if (used >= GUEST_TOKEN_LIMIT) {
      console.log(`[api/chat] ⛔ gate: guest over device limit → 401 sign-in wall`);
      return NextResponse.json(
        { error: "auth_required", reason: "guest_limit",
          message: "Please sign in to continue using Ari ✨" },
        { status: 401, headers: guestCookieHeader(setGuestCookie) },
      );
    }
  }

  const chatModelName = process.env.GEMINI_CHAT_MODEL ?? "gemini-3-flash-preview";

  const t0 = Date.now();
  const ms = () => Date.now() - t0;
  console.log(`[api/chat] ▶ start userId=${userId} chars=${message.length} image=${image ? image.mimeType : "no"} chatModel=${chatModelName}`);

  // Gemini bills a small fixed token count per image tile (~258 for our ≤1024px
  // uploads) — count it so the guest gate can't be bypassed with picture spam.
  const IMAGE_PROMPT_TOKENS = 258;

  // promptTokens/outputTokens stay char-estimates — the guest/daily gates are
  // tuned to them. `real` (Gemini usageMetadata, when the stream delivered it)
  // fills the billed* columns and prices all 4 billed token types.
  function recordUsage(
    kind: "chat" | "safety", model: string, requestText: string, outputText: string,
    blocked: boolean, real?: TokenUsage | null,
  ) {
    const promptTokens = estTokens(requestText) + (image && kind === "chat" ? IMAGE_PROMPT_TOKENS : 0);
    const outputTokens = estTokens(outputText);
    usage.record({
      userId, userLabel, model, kind, promptTokens, outputTokens,
      userAgent: req.headers.get("user-agent"),
      billedPromptTokens: real?.promptTokens,
      billedOutputTokens: real?.outputTokens,
      thoughtTokens: real?.thoughtTokens,
      cachedTokens: real?.cachedTokens,
      costUsd: estimateCostUsd(model, {
        prompt: real?.promptTokens ?? promptTokens,
        output: real?.outputTokens ?? outputTokens,
        thoughts: real?.thoughtTokens,
        cached: real?.cachedTokens,
      }),
      geo, requestText, outputText, blocked,
    });
  }
  function alert(origin: "child" | "model", triggerText: string, v: SafetyVerdict) {
    alerts.record({ origin, category: v.category, severity: v.severity, action: v.action, triggerText, reason: v.reason });
  }

  // ── 1. INPUT: instant deterministic check (no LLM latency) ────────────────
  const inRules = rules.classifySync({ text: message, origin: "child" });
  console.log(`[api/chat] input-rules action=${inRules.action} @${ms()}ms`);
  if (inRules.action !== "allow") {
    alert("child", message, inRules);
    return ndjson((send) => {
      send({ type: "blocked", text: KIND_REDIRECT });
    }, guestCookieHeader(setGuestCookie));
  }

  // ── 2. STREAM generation. Output safety = Gemini built-in blocking + the
  // child-safety system prompt; no post-hoc monitor, so games are NEVER
  // retracted after they stream (chess-block class, BUG-FIX-LOG 2026-07-09).
  return ndjson(async (send) => {
    let full = "";
    let streamUsage: TokenUsage | null = null;
    let servedModel = chatModelName; // fallback/hedge can swap the model mid-turn
    if (replyId) trackTurn(() => turnResults.start(replyId, userId, Date.now()));
    try {
      console.log(`[api/chat] streaming… @${ms()}ms`);
      for await (const chunk of chatModel.replyStream({ history, message, image })) {
        if (chunk.kind === "thought") {
          // Thought summaries drive the kid-facing planning line during the
          // silent thinking phase. kidThoughtLine fails closed (null = drop):
          // never code, never markdown, never a wall of text (2026-07-11).
          const line = kidThoughtLine(chunk.text);
          if (line) send({ type: "thinking", text: line });
          continue; // thoughts are never part of the answer
        }
        if (chunk.kind === "restart") {
          // A model died mid-answer and a fallback is producing a FRESH reply
          // (2026-07-13): drop the partial here too, so done/usage only ever
          // carry the answer the kid actually keeps.
          full = "";
          send({ type: "restart" });
          console.warn(`[api/chat] ↻ mid-answer model restart @${ms()}ms — partial wiped`);
          continue;
        }
        if (chunk.kind === "usage") {
          // Real billed token counts (usageMetadata) — recorded below so the
          // cost dashboard shows what Google charges, not a char/4 estimate.
          // The chunk also names the model that ACTUALLY answered (fallback /
          // hedge race), so the cost uses that model's rate, not the primary's.
          streamUsage = chunk.usage ?? null;
          if (chunk.model) servedModel = chunk.model;
          continue;
        }
        full += chunk.text;
        send({ type: "delta", text: chunk.text });
      }
    } catch (err) {
      console.error(`[api/chat] ✖ stream error @${ms()}ms: ${(err as Error).message}`);
      if (replyId) trackTurn(() => turnResults.fail(replyId, userId, Date.now()));
      send({ type: "error", text: "Oops! Something went wrong. Let's try again." });
      return;
    }
    console.log(`[api/chat] stream done @${ms()}ms chars=${full.length}`);

    // 3D games get their engine import map here — an asset-host URL string
    // spliced in, nothing read, nothing fetched (src/lib/assets/inject.ts).
    // CONTRACT: post-processing can never cost the child the game (BUG-FIX-LOG
    // 2026-07-08: Phase 0's injector read a file the deploy didn't ship →
    // ENOENT → the done event was lost and the preview never opened). On ANY
    // injection failure, fall back to the raw artifact: the preview opens, and
    // a 3D game's import error lands in its Console tab, not a dead end.
    function toDeliverable(rawHtml: string | undefined): string | null {
      if (!rawHtml) return null;
      try {
        const injected = injectAssets(rawHtml);
        if (injected.dropped?.length) {
          console.warn(`[api/chat] asset names dropped fail-soft: ${injected.dropped.join(", ")}`);
        }
        return injected.html;
      } catch (err) {
        console.error(`[api/chat] ✖ asset injection failed @${ms()}ms (serving raw artifact): ${(err as Error).message}`);
        return rawHtml;
      }
    }

    let displayText: string;
    let deliverableHtml: string | null;

    // Patch-based feature edits (BUG-FIX-LOG class fix, 2026-07-18): a
    // follow-up request on an already-good game is answered with a targeted
    // SEARCH/REPLACE patch — the same minimal-patch contract the self-healing
    // repair flow already uses (repair-prompt.ts's applyPatch) — instead of a
    // full-file regeneration, so parts the child never asked to change can't
    // silently regress.
    if (isGameEditTurn(message, history)) {
      const currentHtml = currentGameHtml(history)!; // isGameEditTurn guarantees a game exists
      const applied = applyPatch(currentHtml, full);
      if (applied.ok) {
        console.log(`[api/chat] ✓ edit ${applied.mode} @${ms()}ms`);
        displayText = editReplyProse(full); // the kid-facing sentence only — never the raw hunks
        deliverableHtml = toDeliverable(applied.html);
      } else if (applied.reason === "no_patch_in_reply") {
        // isGameEditTurn is deliberately over-inclusive (true for ANY message
        // once a game exists, matching isGameBuildTurn's own tradeoff —
        // builder-mode.ts). GAME_EDIT_PROMPT_SECTION is hedged for exactly
        // this: an off-topic message gets an ordinary reply, no patch
        // attempted. Treat it as plain chat — the game stays untouched, and a
        // whole extra generation is NOT wasted regenerating it for nothing.
        console.log(`[api/chat] edit turn was off-topic chat (no patch attempted) @${ms()}ms`);
        displayText = full;
        deliverableHtml = null;
      } else {
        // The model DID attempt an edit (SEARCH markers present) but it
        // didn't cleanly apply (${applied.reason}) — a genuine failed edit,
        // so fall back to ONE full-regeneration call rather than a dead end.
        // Floor stays "no worse than before this feature existed."
        console.warn(`[api/chat] patch failed (${applied.reason}) — falling back to full regeneration @${ms()}ms`);
        try {
          const fallback = await chatModel.reply({ history, message, image, forceFullRegen: true });
          trackTurn(() => recordUsage("chat", servedModel, message, fallback.text, false, fallback.usage));
          displayText = fallback.artifactHtml && !fallback.wasFenced
            ? `${fallback.text}\n\n\`\`\`html\n${fallback.artifactHtml}\n\`\`\``.trim()
            : fallback.text;
          deliverableHtml = toDeliverable(fallback.artifactHtml);
        } catch (err) {
          console.error(`[api/chat] ✖ fallback regeneration failed @${ms()}ms: ${(err as Error).message}`);
          send({ type: "error", text: "Oops! Something went wrong. Let's try again." });
          if (replyId) trackTurn(() => turnResults.fail(replyId, userId, Date.now()));
          return;
        }
      }
    } else {
      const { text: prose, artifactHtml, wasFenced } = extractArtifact(full);
      deliverableHtml = toDeliverable(artifactHtml);
      // Send the FULL text (code block kept inline, Gemini-style) for the chat,
      // and the extracted HTML for the side panel preview. When the model didn't
      // produce one clean ```html fence (truncated mid-fence, or no fence at all
      // — extractArtifact's fallback cases), `full` still carries raw, unfenced
      // HTML/CSS/JS: the markdown renderer would reinterpret its indentation as
      // a series of CommonMark "indented code blocks," each spawning its own
      // stray code-card widget in the chat bubble (BUG-FIX-LOG 2026-07-14,
      // reproduced against the real remark/react-markdown stack). Re-fence it so
      // the bubble always shows one clean, collapsible code block. The
      // already-working case (a clean fence) is untouched byte-for-byte,
      // including any trailing prose after the closing fence.
      displayText = artifactHtml && !wasFenced
        ? `${prose}\n\n\`\`\`html\n${artifactHtml}\n\`\`\``.trim()
        : full;
    }
    send({ type: "done", text: displayText, artifactHtml: deliverableHtml });
    // Keep the finished result server-side even if nobody is listening — a
    // disconnected client polls /api/chat/result instead of re-generating.
    if (replyId) trackTurn(() => turnResults.complete(replyId, userId, displayText, deliverableHtml, Date.now()));
    // Meter the FULL reply (BUG-FIX-LOG 2026-07-13): `cleaned` strips the
    // game code block — 90%+ of a build turn's billed output — so the cost
    // dashboard undercounted ~75x. Google bills for `full`; so do we.
    // Wrapped in trackTurn (2026-07-17): this is bookkeeping like the turnResults
    // call above it — a DB write failure here must not turn an already-shown
    // reply into a 500 for the kid.
    trackTurn(() => recordUsage("chat", servedModel, message, full, false, streamUsage));
    // Screen-time cap (PRD-SCREEN-TIME-CAP-MVP Part B) — a completion always
    // records its own ping (so a short session counts even before the first
    // heartbeat tick), plus ScreenTimeHeartbeat.tsx pings independently while
    // the tab stays open/visible (chatting or playing). Fail-open: bookkeeping
    // must never break chat, same contract as trackTurn above.
    if (signedIn) {
      try {
        const screenTime = new SqliteScreenTimeStore();
        const now = Date.now();
        screenTime.recordPing(userId, now);
        screenTime.recomputeAndMaybeAlert(userId, userLabel, now);
      } catch (err) {
        console.warn(`[api/chat] screen-time tracking failed (ignored): ${(err as Error).message}`);
      }
    }
    console.log(`[api/chat] ✓ shown @${ms()}ms`);
  }, guestCookieHeader(setGuestCookie));
}

/** Resolve the shared Ariantra SSO session, but never throw — if auth is
 *  misconfigured (e.g. AUTH_JWT_SECRET unset) we fail safe to "guest". */
async function safeAuth() {
  try {
    return await getAriantraSession();
  } catch (err) {
    console.warn(`[api/chat] session unavailable, treating as guest: ${(err as Error).message}`);
    return null;
  }
}

/** Set-Cookie header that persists a brand-new guest identity (httpOnly so the client can't forge it).
 *  Scoped to the whole apex domain in production (same knob + pattern as the
 *  shared SSO cookie, `/api/logout`) — a host-only cookie would mint a fresh
 *  guest identity on every canonical-domain rename and orphan the old one's
 *  chat history (BUG-FIX-LOG 2026-07-18). No Domain in dev: `.localhost` isn't
 *  a valid cookie domain for `http://localhost`. */
function guestCookieHeader(guestId: string | null): Record<string, string> | undefined {
  if (!guestId) return undefined;
  const domain =
    process.env.SESSION_COOKIE_DOMAIN ??
    (process.env.NODE_ENV === "production" ? ".ariantra.com" : undefined);
  const parts = [`${GUEST_COOKIE}=${guestId}`, "Path=/", `Max-Age=${GUEST_COOKIE_MAX_AGE_S}`, "HttpOnly", "SameSite=Lax"];
  if (domain) parts.push(`Domain=${domain}`);
  return { "Set-Cookie": parts.join("; ") };
}

/** Wraps a producer in an NDJSON streaming Response. `extraHeaders` lets callers attach e.g.
 *  the guest-identity Set-Cookie without leaking response plumbing into the gate logic. */
function ndjson(
  produce: (send: (obj: unknown) => void) => void | Promise<void>,
  extraHeaders?: Record<string, string>,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // Phones drop the socket mid-stream (screen lock / app switch) — after
      // that every enqueue throws "Controller is already closed". Sends turn
      // into no-ops instead: the generation finishes quietly (the safety
      // monitor still runs) and the log gets ONE info line, not an ERROR per
      // token (BUG-FIX-LOG 2026-07-07).
      let closed = false;
      const send = (obj: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        } catch {
          closed = true;
          console.log("[api/chat] client disconnected mid-stream — continuing quietly");
        }
      };
      try {
        await produce(send);
      } finally {
        if (!closed) {
          try { controller.close(); } catch { /* closed by client cancel */ }
        }
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
      ...(extraHeaders ?? {}),
    },
  });
}
