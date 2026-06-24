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
import { SqliteAlertStore, SqliteUsageStore } from "@/lib/db";
import { resolveGeo } from "@/lib/geo";
import { estimateCostUsd } from "@/lib/pricing.config";
import type { ChatMessage } from "@/types/chat.types";
import type { SafetyVerdict } from "@/types/safety.types";

export const runtime = "nodejs";

const classifier = new FlashLiteClassifier();
const rules = new RulesClassifier();
const chatModel = new GeminiChatModel();
const alerts = new SqliteAlertStore();
const usage = new SqliteUsageStore();

const KIND_REDIRECT =
  "Let's talk about something else! How about a fun fact, a story, or a game? 🌟";
const SAFETY_HTML_SAMPLE = 3000;

const estTokens = (t: string) => Math.ceil(t.length / 4);

export async function POST(req: NextRequest) {
  const geo = resolveGeo(req);
  let body: { message?: string; history?: ChatMessage[]; userId?: string; userLabel?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const message = (body.message ?? "").trim();
  const history = body.history ?? [];
  const userId = body.userId ?? "default-child";
  const userLabel = body.userLabel ?? null;
  if (!message) return NextResponse.json({ error: "Empty message" }, { status: 400 });

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
    });
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
  });
}

/** Wraps a producer in an NDJSON streaming Response. */
function ndjson(produce: (send: (obj: unknown) => void) => void | Promise<void>): Response {
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
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache" },
  });
}
