// POST /api/chat — the safety boundary, now STREAMING.
// Posture (user-chosen): live-stream tokens while Gemini's built-in strict safety blocks
// in real time; the Flash-Lite gate runs as a parallel monitor that can retract + alert.
// Input is pre-checked with instant deterministic rules so safe prompts don't wait ~2s.
// Response is NDJSON: {type:"delta"|"done"|"blocked"|"error", ...}. See CLAUDE.md § 3.

import "@/lib/logger"; // tees all server console output to logs/app.log
import { NextRequest, NextResponse } from "next/server";
import { GeminiChatModel, extractArtifact } from "@/lib/gemini";
import { FlashLiteClassifier } from "@/lib/safety";
import { RulesClassifier } from "@/lib/safety.rules";
import { SqliteAlertStore, SqliteUsageStore, SqliteRateLimitStore } from "@/lib/db";
import { resolveGeo } from "@/lib/geo";
import { estimateCostUsd } from "@/lib/pricing.config";
import { getAriantraSession } from "@/lib/ariantra-session.server";
import { GUEST_TOKEN_LIMIT, GUEST_COOKIE, GUEST_COOKIE_MAX_AGE_S, GUEST_WINDOW_MS, IP_GUEST_TOKEN_CAP, signedInDailyTokenLimit } from "@/lib/gate.config";
import type { ChatMessage } from "@/types/chat.types";
import type { SafetyVerdict } from "@/types/safety.types";

export const runtime = "nodejs";

const classifier = new FlashLiteClassifier();
const rules = new RulesClassifier();
const chatModel = new GeminiChatModel();
const alerts = new SqliteAlertStore();
const usage = new SqliteUsageStore();
const rateLimit = new SqliteRateLimitStore();

const KIND_REDIRECT =
  "Let's talk about something else! How about a fun fact, a story, or a game? 🌟";
const SAFETY_HTML_SAMPLE = 3000;

const estTokens = (t: string) => Math.ceil(t.length / 4);

export async function POST(req: NextRequest) {
  const geo = resolveGeo(req);
  let body: { message?: string; history?: ChatMessage[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const message = (body.message ?? "").trim();
  const history = body.history ?? [];
  if (!message) return NextResponse.json({ error: "Empty message" }, { status: 400 });

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
      guestId = `guest:${crypto.randomUUID()}`;
      setGuestCookie = guestId; // brand-new device — persist the identity on the response
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
            message: "Please sign in to continue using KidGemini ✨" },
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
          message: "Please sign in to continue using KidGemini ✨" },
        { status: 401, headers: guestCookieHeader(setGuestCookie) },
      );
    }
  }

  const safetyModel = process.env.GEMINI_SAFETY_MODEL ?? "gemini-2.5-flash-lite";
  const chatModelName = process.env.GEMINI_CHAT_MODEL ?? "gemini-2.5-flash";

  const t0 = Date.now();
  const ms = () => Date.now() - t0;
  console.log(`[api/chat] ▶ start userId=${userId} chars=${message.length} chatModel=${chatModelName}`);

  function recordUsage(kind: "chat" | "safety", model: string, requestText: string, outputText: string, blocked: boolean) {
    const promptTokens = estTokens(requestText);
    const outputTokens = estTokens(outputText);
    usage.record({
      userId, userLabel, model, kind, promptTokens, outputTokens,
      costUsd: estimateCostUsd(model, promptTokens, outputTokens),
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
  // LLM input check runs in the BACKGROUND purely for parent alerting — never blocks the stream.
  classifier.classify({ text: message, origin: "child" }).then((v) => {
    recordUsage("safety", safetyModel, message, JSON.stringify(v), v.action !== "allow");
    if (v.action !== "allow") alert("child", message, v);
  }).catch(() => {});

  // ── 2. STREAM generation; 3. monitor output safety after stream ───────────
  return ndjson(async (send) => {
    let full = "";
    try {
      console.log(`[api/chat] streaming… @${ms()}ms`);
      for await (const delta of chatModel.replyStream({ history, message })) {
        full += delta;
        send({ type: "delta", text: delta });
      }
    } catch (err) {
      console.error(`[api/chat] ✖ stream error @${ms()}ms: ${(err as Error).message}`);
      send({ type: "error", text: "Oops! Something went wrong. Let's try again." });
      return;
    }
    console.log(`[api/chat] stream done @${ms()}ms chars=${full.length}`);

    const { text: cleaned, artifactHtml } = extractArtifact(full);
    // Finalize the message NOW — the child already watched it stream in. Send the FULL
    // text (code block kept inline, Gemini-style) for the chat, and the extracted HTML
    // for the side panel preview. The output monitor runs next and can RETRACT.
    send({ type: "done", text: full, artifactHtml: artifactHtml ?? null });
    console.log(`[api/chat] ✓ shown @${ms()}ms; running output monitor…`);

    const toCheck = `${cleaned}\n${(artifactHtml ?? "").slice(0, SAFETY_HTML_SAMPLE)}`;
    const outVerdict = await classifier.classify({ text: toCheck, origin: "model" });
    console.log(`[api/chat] output-monitor action=${outVerdict.action} @${ms()}ms`);
    recordUsage("chat", chatModelName, message, cleaned, outVerdict.action !== "allow");
    recordUsage("safety", safetyModel, toCheck, JSON.stringify(outVerdict), outVerdict.action !== "allow");

    if (outVerdict.action !== "allow") {
      alert("model", toCheck, outVerdict);
      send({ type: "retract", text: KIND_REDIRECT });
      console.log(`[api/chat] ⟲ retracted @${ms()}ms`);
    }
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

/** Set-Cookie header that persists a brand-new guest identity (httpOnly so the client can't forge it). */
function guestCookieHeader(guestId: string | null): Record<string, string> | undefined {
  if (!guestId) return undefined;
  return {
    "Set-Cookie": `${GUEST_COOKIE}=${guestId}; Path=/; Max-Age=${GUEST_COOKIE_MAX_AGE_S}; HttpOnly; SameSite=Lax`,
  };
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
