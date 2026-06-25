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
import { auth } from "@/auth";
import { GUEST_TOKEN_LIMIT, GUEST_COOKIE, GUEST_COOKIE_MAX_AGE_S } from "@/lib/gate.config";
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
  const signedIn = Boolean(session?.user);

  // Force sign-in upfront: unauthenticated callers are rejected here, fail-closed, before any
  // Gemini token is spent. This is the server contract behind the UI's sign-in screen — the
  // client never sends an unauthenticated chat request, but if one slips through (curl, a stale
  // tab, a proxy) it gets a clean 401 instead of silently consuming the guest allowance.
  // (The guest branch below is retained but unreachable while this gate is in force.)
  if (!signedIn) {
    console.log(`[api/chat] ⛔ unauthenticated → 401 auth_required`);
    return NextResponse.json({ error: "auth_required" }, { status: 401 });
  }

  let setGuestCookie: string | null = null;
  let userId: string;
  let userLabel: string | null;

  if (signedIn) {
    userId = `user:${session!.user!.email ?? session!.user!.name ?? "google"}`;
    userLabel = session!.user!.name ?? session!.user!.email ?? null;
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
        return ndjson(
          (send) =>
            send(
              rl.mustPay
                ? {
                    type: "paywall",
                    text: "You've hit the free limit too many times. Upgrade to keep chatting — or sign in with Google. 💳",
                  }
                : {
                    type: "rate_limited",
                    text: "Whoa, slow down! 🐢 That's a lot of messages — take a break and come back tomorrow, or sign in with Google to keep going.",
                  },
            ),
          guestCookieHeader(setGuestCookie),
        );
      }
    }

    const used = usage.tokensUsedByUser(guestId);
    console.log(`[api/chat] guest ${guestId} used=${used}/${GUEST_TOKEN_LIMIT} tokens`);
    if (used >= GUEST_TOKEN_LIMIT) {
      console.log(`[api/chat] ⛔ gate: guest over limit → require sign-in`);
      return ndjson(
        (send) =>
          send({
            type: "gate",
            text: "You've reached the free limit — sign in with Google to keep chatting! ✨",
          }),
        guestCookieHeader(setGuestCookie),
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

/** Resolve the Auth.js session, but never throw — if auth is misconfigured (e.g. before the
 *  Google credentials are set) we fail safe to "guest" so the app still runs. */
async function safeAuth() {
  try {
    return await auth();
  } catch (err) {
    console.warn(`[api/chat] auth() unavailable, treating as guest: ${(err as Error).message}`);
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
      const send = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      try {
        await produce(send);
      } finally {
        controller.close();
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
