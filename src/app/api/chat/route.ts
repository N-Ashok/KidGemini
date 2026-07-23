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
import { writeDecision } from "@/lib/model-ledger";
import type { ChainSummary } from "@/types/model-ledger.types";
import { SafetyBlockedError } from "@/lib/model-runner";
import {
  isGameEditTurn, currentGameHtml, editReplyProse, looksLikeAttemptedEdit, looksLikeCompleteDocument, looksTruncatedDocument,
  regenReplyProse, reconcileAssetMarkers, detectsNewGame, NEW_GAME_PROMPT_LINE, REBUILT_GAME_LINE, FRESH_GAME_LINE,
} from "@/lib/game-edit";
import { stripAssetMarkers } from "@/lib/assets/markers";
import { applyPatch } from "@/lib/repair-prompt";
import { injectAssets } from "@/lib/assets/inject";
import { newUnknownThreeImports, unknownThreeImports } from "@/lib/assets/three-import-lint";
import { CURATED_IMPORT_NAMES } from "@/lib/assets/prompt-catalog";
import { ensureMultiplayerMarker } from "@/lib/multiplayer-gate";
import { kidThoughtLine } from "@/lib/kid-thought";
import { trimHistory } from "@/lib/history-trim";
import { RulesClassifier } from "@/lib/safety.rules";
import { KIND_REDIRECT, MODEL_GLITCH_RETRY, BUILD_INCOMPLETE_RETRY, BUILD_STARTER_SPLIT } from "@/lib/chat-copy";
import { SqliteAlertStore, SqliteUsageStore, SqliteRateLimitStore, SqliteTurnResultStore, SqliteScreenTimeStore } from "@/lib/db";
import { resolveGeo } from "@/lib/geo";
import { estimateCostUsd } from "@/lib/pricing.config";
import { getAriantraSession } from "@/lib/ariantra-session.server";
import { resolvePersona } from "@/lib/persona/persona";
import { GUEST_COOKIE, GUEST_COOKIE_LEGACY, GUEST_COOKIE_MAX_AGE_S, GUEST_WINDOW_MS, IP_GUEST_TOKEN_CAP, guestTokenLimitFor, signedInDailyTokenLimit } from "@/lib/gate.config";
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

const estTokens = (t: string) => Math.ceil(t.length / 4);

export async function POST(req: NextRequest) {
  const geo = resolveGeo(req);
  let body: { message?: string; history?: ChatMessage[]; image?: unknown; replyId?: unknown; activeGameMessageId?: unknown; forceRebuild?: unknown; differentVersion?: unknown; persona?: unknown };
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
  // "Continue from here" (chat-rewind.ts): the client names an EARLIER game
  // message to build on instead of the newest one, for exactly this turn —
  // it clears its own pin once sent, so there's nothing to persist here.
  const activeGameMessageId = typeof body.activeGameMessageId === "string" ? body.activeGameMessageId : undefined;
  // "Change this one ✏️" after a new-game prompt (PRD-RESILIENT-GENERATION §11):
  // the child consented to rebuild in place, so skip new-game detection and the
  // edit-patch path — build the new game fresh, here, this turn.
  const forceRebuild = body.forceRebuild === true;
  // "🔄 Different one" (PRD-INSTANT-ALTERNATE, on-demand): regenerate this turn
  // led by the fallback model, so the child gets a genuinely different take.
  const preferAlternateModel = body.differentVersion === true;
  // Persona REQUEST (PRD-BIBLE-TEACHER). This is only what the client ASKED for
  // (the /bible-teacher surface sends "bible-teacher"); it selects the guest
  // trial allowance below and is fail-closed against the verified session before
  // it is honored (resolvePersona). A client can never opt into the relaxed
  // authoring posture with this flag alone.
  const requestedPersona = typeof body.persona === "string" ? body.persona : undefined;
  // Trim what the MODEL sees (stale game versions stripped + sliding window,
  // see history-trim.ts) — the client's stored conversation is untouched.
  const history = trimHistory(body.history ?? [], activeGameMessageId);
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

  // Fail-closed persona resolution (PRD-BIBLE-TEACHER §4, defense in depth): the
  // relaxed teacher persona is honored ONLY for a verified-adult session, no
  // matter what the body requested. Guest / signed-in-but-not-adult / spoofed
  // flag → `default` (child) persona + child safety. This is the API-side gate;
  // the /bible-teacher page runs its own login+age gate independently.
  const persona = resolvePersona(requestedPersona, session);

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

    // The bible-teacher surface gets a SMALLER free trial (PRD §3a) before the
    // sign-in + adult gate; every other surface keeps the default guest limit.
    const guestLimit = guestTokenLimitFor(requestedPersona);
    const used = usage.tokensUsedByUser(guestId, Date.now() - GUEST_WINDOW_MS);
    console.log(`[api/chat] guest ${guestId} used=${used}/${guestLimit} tokens (persona=${requestedPersona ?? "default"})`);
    if (used >= guestLimit) {
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

  // Per-request model-decision ledger (owner ask 2026-07-21). Each model-call
  // EPISODE this turn fires — the streamed answer, plus any strict-edit retry or
  // patch-fallback regeneration — writes its own line to logs/model-decisions.jsonl,
  // all sharing this request's id, tagged by `kind`. That makes "one request,
  // N model calls, this one won" answerable long after the fact — the piece
  // usage_events (winner-only) and app.log (fallback lines only) can't give.
  const mkLedger = (kind: string) => (summary: ChainSummary) =>
    writeDecision({
      ts: new Date().toISOString(),
      reqId: replyId ?? "no-reply-id",
      userId, kind,
      chain: summary.chain, attempts: summary.attempts, winner: summary.winner,
      calls: summary.attempts.length,
    });

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
  // A LOSING call from a one-shot fan-out (a backup that finished after the
  // winner) — owner ask 2026-07-21. It's real, already-paid work, so record it
  // as kind:"fallback": COUNTED in the dashboard cost total, but EXEMPT from the
  // child's quota (our race waste isn't their spend — see db.ts gate queries).
  // Fires asynchronously, AFTER the response has streamed; fail-safe like every
  // other bookkeeping write. Real billed usage when the provider reported it;
  // otherwise output is estimated from the loser's own text.
  function recordLoser(model: string, real: TokenUsage | undefined, outputText: string) {
    try {
      const promptTokens = estTokens(message) + (image ? IMAGE_PROMPT_TOKENS : 0);
      const outputTokens = real?.outputTokens ?? estTokens(outputText);
      usage.record({
        userId, userLabel, model, kind: "fallback", promptTokens, outputTokens,
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
        geo, requestText: message, outputText, blocked: false,
      });
      console.log(`[api/chat] 💸 billed losing call ${model} (kind=fallback, ${outputTokens} out tok) @${ms()}ms`);
    } catch { /* bookkeeping must never break a turn */ }
  }

  // ── 1. INPUT: instant deterministic check (no LLM latency) ────────────────
  const inRules = rules.classifySync({ text: message, origin: "child" });
  console.log(`[api/chat] input-rules action=${inRules.action} persona=${persona.id} @${ms()}ms`);
  // Adult authoring mode (verified-adult bible-teacher persona, PRD §4): the
  // teacher is an adult author of their OWN typing, so a PII soft-block is not a
  // child-safety concern and there is no parent to alert — only HARD blocks
  // (profanity / self-harm) still apply, the same safety floor as everyone.
  // Child (default) mode blocks on ANY non-allow verdict and fires a parent
  // alert, exactly as before.
  const blockedByRules =
    persona.inputRuleMode === "adult" ? inRules.action === "hard_block" : inRules.action !== "allow";
  if (blockedByRules) {
    if (persona.inputRuleMode !== "adult") alert("child", message, inRules);
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
      for await (const chunk of chatModel.replyStream({ history, message, image, activeGameMessageId, forceRebuild, preferAlternateModel, persona: persona.id, onLedger: mkLedger("chat") })) {
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
      // A model SAFETY block (finishReason SAFETY, KNOWN_BUGS #4) is a VERDICT,
      // not an outage: the runner fails closed rather than trying to route around
      // it. Show the kind redirect (never a scary error), and log a model-origin
      // alert so a parent can see it — the same treatment as an input block.
      if (err instanceof SafetyBlockedError) {
        // Log WHICH provider safety category fired (attribution, owner ask
        // 2026-07-22) — the info to tell a genuine block from a false-positive
        // on benign content (a pastor's Bible game). No posture change.
        const ratings = err.safetyInfo ?? "no ratings reported";
        console.warn(`[api/chat] ⛔ model output safety-blocked @${ms()}ms [${ratings}] — redirecting (fail closed)`);
        alert("model", full || message, { category: null, severity: "high", action: "hard_block", reason: `model output blocked by the provider (finishReason SAFETY) — ${ratings}` });
        if (replyId) trackTurn(() => turnResults.fail(replyId, userId, Date.now()));
        send({ type: "blocked", text: MODEL_GLITCH_RETRY });
        return;
      }
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
        // Marker insurance (2026-07-18): real SDK multiplayer code without the
        // opt-in marker = an invite button that never appears. Self-gating —
        // byte-identical pass-through for everything else.
        return ensureMultiplayerMarker(injected.html);
      } catch (err) {
        console.error(`[api/chat] ✖ asset injection failed @${ms()}ms (serving raw artifact): ${(err as Error).message}`);
        return ensureMultiplayerMarker(rawHtml);
      }
    }

    // Completeness guard, shared by the fresh-build AND edit-fallback delivery
    // paths (BUG-FIX-LOG 2026-07-22). The model can return finishReason STOP
    // ("done") on a TRUNCATED game (opened <html>, no </html>) — proven: the
    // owner's "30 New Testament characters" prompt stopped ~5K chars run after
    // run. Nothing verified the HTML closed, so the partial shipped blank. Don't
    // trust "done": on a truncated build, ONE corrective regen demanding a
    // COMPLETE + COMPACT document. Returns the recovered reply, `null` if the
    // build was fine (nothing to do), or "incomplete" when even the retry was
    // cut off — the caller must then show BUILD_INCOMPLETE_RETRY, never a blank
    // artifact. (An EDIT that falls back to a full rebuild goes through this too,
    // so an old chat gets the same protection a new chat does.)
    // `null` = build was fine; `{status:"incomplete"}` = even the reduced build
    // was cut off (caller shows BUILD_INCOMPLETE_RETRY); `{status:"recovered"}` =
    // a usable game — `reduced:true` means it's a SMALL STARTER SUBSET, so the
    // caller leads with BUILD_STARTER_SPLIT and offers to add the rest.
    type RecoveredBuild =
      | null
      | { status: "incomplete" }
      | { status: "recovered"; reply: Awaited<ReturnType<typeof chatModel.reply>>; reduced: boolean };

    async function completeTruncatedBuild(art: string | undefined): Promise<RecoveredBuild> {
      if (!art || !looksTruncatedDocument(art)) return null;
      console.warn(`[api/chat] ⚠ build output incomplete (opened <html>, no </html>, ${art.length} chars) — corrective retry @${ms()}ms`);
      // Diagnostic (2026-07-23): a truncation this SHORT (well under the 24576
      // output cap) means the model stopped early on its own, not a size limit.
      // Dump the head+tail of what it produced so we can tell a genuine partial
      // game from a stub / an in-HTML refusal / a wrong-shaped response.
      console.warn(`[api/chat]   ⤷ truncated HEAD: ${JSON.stringify(art.slice(0, 200))}`);
      console.warn(`[api/chat]   ⤷ truncated TAIL: ${JSON.stringify(art.slice(-160))}`);
      // Pass 1: same scope, told to finish COMPLETE + COMPACT.
      try {
        const retry = await chatModel.reply({
          history,
          message:
            `${message}\n\n(IMPORTANT: your previous attempt was CUT OFF before it finished — ` +
            `it did not end with </html>. Output the COMPLETE, self-contained HTML document ` +
            `this time, ending with </html>. Keep it COMPACT so the whole thing fits in one ` +
            `response: store repeated data such as lists of characters/items in a JavaScript ` +
            `array and loop over it instead of writing each one out by hand. Do not truncate.)`,
          image,
          forceFullRegen: true,
          persona: persona.id,
          // A model that STUBS a build returns a successful short reply, so the
          // ordinary chain never advances past it (BUG-FIX-LOG 2026-07-23). Lead
          // the retry with the ALTERNATE model — a different model is far more
          // likely to actually finish than the one that just gave up.
          preferAlternateModel: true,
          onLedger: mkLedger("regen"),
        });
        trackTurn(() => recordUsage("chat", servedModel, message, retry.text, false, retry.usage));
        if (retry.artifactHtml && !looksTruncatedDocument(retry.artifactHtml)) {
          console.log(`[api/chat] ✓ completeness corrective retry produced a whole game (alternate model) @${ms()}ms`);
          return { status: "recovered", reply: retry, reduced: false };
        }
        console.warn(`[api/chat] retry STILL incomplete — auto-splitting into a working starter build @${ms()}ms`);
      } catch (err) {
        console.warn(`[api/chat] completeness retry unavailable (${(err as Error).message}) — auto-splitting into a working starter build @${ms()}ms`);
      }
      // Pass 2 (auto-split, owner ask 2026-07-23): don't dead-end — build a
      // WORKING game NOW with a small representative subset. It finishes because
      // it's small; the caller then offers to add the full set as a follow-up
      // (an edit/patch turn on the game that now exists — far more reliable than
      // re-generating the whole content-heavy game from scratch).
      try {
        const starter = await chatModel.reply({
          history,
          message:
            `${message}\n\n(Your previous attempts were CUT OFF — there was too much to generate ` +
            `at once. Build a COMPLETE, WORKING game NOW using only a SMALL representative subset ` +
            `of the data — about 6 to 10 items — and END with </html>. Do NOT include the full ` +
            `list; a small working game that finishes is required. Keep the data in a JavaScript ` +
            `array so more can be added later. Do not truncate.)`,
          image,
          forceFullRegen: true,
          persona: persona.id,
          preferAlternateModel: true, // still on the alternate model — the primary already stubbed twice
          onLedger: mkLedger("regen"),
        });
        trackTurn(() => recordUsage("chat", servedModel, message, starter.text, false, starter.usage));
        if (starter.artifactHtml && !looksTruncatedDocument(starter.artifactHtml)) {
          console.log(`[api/chat] ✓ auto-split starter build finished — shipping with an "add the rest" offer @${ms()}ms`);
          return { status: "recovered", reply: starter, reduced: true };
        }
        console.warn(`[api/chat] starter build STILL incomplete — NOT shipping a blank game @${ms()}ms`);
        return { status: "incomplete" };
      } catch (err) {
        console.warn(`[api/chat] starter build unavailable (${(err as Error).message}) — NOT shipping a blank game @${ms()}ms`);
        return { status: "incomplete" };
      }
    }

    // Initialised (never actually used unset — every branch below assigns): the
    // cheap-rung path (Option 6) assigns inside a try guarded by `rescued`, which
    // TS can't correlate with definite assignment.
    let displayText = "";
    let deliverableHtml: string | null = null;
    // Set when the model self-declared a whole-new-game request (PRD §11): the
    // done event carries it so the client shows the two-button consent prompt.
    let newGamePrompt = false;

    // Patch-based feature edits (BUG-FIX-LOG class fix, 2026-07-18): a
    // follow-up request on an already-good game is answered with a targeted
    // SEARCH/REPLACE patch — the same minimal-patch contract the self-healing
    // repair flow already uses (repair-prompt.ts's applyPatch) — instead of a
    // full-file regeneration, so parts the child never asked to change can't
    // silently regress.
    // forceRebuild ("Change this one ✏️", PRD §11) skips this whole path — the
    // child already consented to rebuild the new game in place, so it takes the
    // ordinary fresh-build branch below.
    if (!forceRebuild && isGameEditTurn(message, history, activeGameMessageId)) {
      const currentHtml = currentGameHtml(history, activeGameMessageId)!; // isGameEditTurn guarantees a game exists
      // Debug trail (2026-07-18 search_not_found class): make it obvious from
      // the log alone WHICH source a patch was applied against, and — on a
      // mismatch — whether the model's SEARCH text exists in that source at
      // all. A persistent "inSource=false" streak means the model is looking
      // at a DIFFERENT version than we're patching (the history-trim bug).
      console.log(
        `[api/chat] edit turn: source=${activeGameMessageId ? `pinned:${activeGameMessageId}` : "newest"} len=${currentHtml.length} reply chars=${full.length}`,
      );
      const logSearchMiss = (reply: string) => {
        const firstSearch = reply.match(/<{7} SEARCH\n([\s\S]*?)\n={7}/)?.[1];
        if (firstSearch === undefined) return;
        const head = firstSearch.slice(0, 80).replace(/\n/g, "\\n");
        // inSource: does the SEARCH text exist in the source we patch? afterMarkerStrip:
        // would it match once asset markers are removed as injection removed them?
        // afterMarkerStrip=true on an inSource=false miss CONFIRMS KNOWN_BUGS #5's
        // asset-marker mechanism as the cause (vs the model quoting a version we
        // never held). The reconciliation below already handles the safe subset;
        // this line pins WHICH cause each remaining miss is, from the log alone.
        const inSource = currentHtml.includes(firstSearch);
        const afterMarkerStrip = !inSource && stripAssetMarkers(currentHtml).includes(stripAssetMarkers(firstSearch));
        console.warn(`[api/chat]   first SEARCH head: "${head}" inSource=${inSource} afterMarkerStrip=${afterMarkerStrip}`);
      };
      let applied = applyPatch(currentHtml, full);
      // inSource=false rescue (KNOWN_BUGS #5): the model re-emitted asset markers
      // injectAssets had stripped from the stored game, so its SEARCH can't be
      // found. Reconcile them out (guarded — only when it can't regress a new
      // asset) and re-apply BEFORE escalating to a full regeneration.
      if (!applied.ok && applied.reason === "search_not_found") {
        const reconciled = reconcileAssetMarkers(currentHtml, full);
        if (reconciled) {
          const retry = applyPatch(currentHtml, reconciled);
          if (retry.ok) {
            applied = retry;
            console.log(`[api/chat] ✓ edit patch after asset-marker reconciliation @${ms()}ms`);
          }
        }
      }
      // Three-import lint (BUG-FIX-LOG 2026-07-20 "DoubleSide"): a patch that
      // INTRODUCES an import the vendored bundle doesn't export would kill
      // the whole game on its import line — that's a failed patch, not a
      // success, so it takes the same fallback-regeneration path below.
      const patchBadImports =
        applied.ok && applied.mode === "patch" ? newUnknownThreeImports(currentHtml, applied.html) : [];
      if (patchBadImports.length) {
        console.warn(`[api/chat] ⛔ patch introduces unknown three imports: ${patchBadImports.join(", ")} @${ms()}ms`);
      }
      if (detectsNewGame(full)) {
        // The model self-declared this is a whole NEW game, not an edit (PRD §11).
        // Ask before any destructive rebuild — nothing is touched: the current
        // game stays in the preview (done carries a null artifact, which
        // nextArtifact keeps) until the child picks "New game" or "Change this one".
        console.log(`[api/chat] 🎮 new-game request self-declared — offering fresh chat @${ms()}ms`);
        displayText = NEW_GAME_PROMPT_LINE;
        deliverableHtml = null;
        newGamePrompt = true;
      } else if (applied.ok && applied.mode === "patch" && patchBadImports.length === 0) {
        console.log(`[api/chat] ✓ edit patch @${ms()}ms`);
        displayText = editReplyProse(full); // the kid-facing sentence only — never the raw hunks
        deliverableHtml = toDeliverable(applied.html);
      } else if (applied.ok && applied.mode === "regeneration" && looksLikeCompleteDocument(applied.html)) {
        // The model ignored the patch instruction and rewrote the whole game.
        // Penguin-maze hardening 2026-07-18: this loophole took 17 of 18 real
        // edit turns, regressing untouched parts (controls flipped, colors
        // changed) every time — so it no longer counts as silent success.
        // ONE hunks-only retry against the same source; a clean retry patch
        // wins, anything else (NEEDS_FULL_REBUILD, garbage, a thrown error)
        // falls back to accepting the rewrite — floor stays "no worse than
        // before" — but with the honest rebuilt-game line, never a bare
        // "small change done" claim. (looksLikeCompleteDocument still guards
        // the accept: a partial snippet is handled by the else branch below.)
        displayText = regenReplyProse(full);
        deliverableHtml = toDeliverable(applied.html);
        try {
          const retry = await chatModel.strictEditRetry({ currentHtml, message, persona: persona.id, onLedger: mkLedger("strict-edit"), onLoserCost: recordLoser });
          trackTurn(() => recordUsage("chat", servedModel, message, retry.text, false, retry.usage));
          const retryApplied = applyPatch(currentHtml, retry.text);
          if (retryApplied.ok && retryApplied.mode === "patch") {
            console.log(`[api/chat] ✓ edit patch (strict retry) @${ms()}ms`);
            displayText = editReplyProse(retry.text);
            deliverableHtml = toDeliverable(retryApplied.html);
          } else {
            const why = retryApplied.ok ? `mode=${retryApplied.mode}` : retryApplied.reason;
            console.log(`[api/chat] edit regeneration accepted (strict retry declined: ${why}) @${ms()}ms`);
            logSearchMiss(retry.text);
          }
        } catch (err) {
          console.warn(`[api/chat] strict edit retry unavailable (${(err as Error).message}) — accepting rewrite @${ms()}ms`);
        }
      } else if (!applied.ok && applied.reason === "no_patch_in_reply" && !looksLikeAttemptedEdit(full)) {
        // isGameEditTurn is deliberately over-inclusive (true for ANY message
        // once a game exists, matching isGameBuildTurn's own tradeoff —
        // builder-mode.ts). GAME_EDIT_PROMPT_SECTION is hedged for exactly
        // this: an off-topic message gets an ordinary reply, no patch
        // attempted. Treat it as plain chat — the game stays untouched, and a
        // whole extra generation is NOT wasted regenerating it for nothing.
        // looksLikeAttemptedEdit guards this: a message that DOES carry
        // patch/code traces (a truncated SEARCH block, a code fence, raw
        // HTML) is a malformed attempt, not off-topic chat — see the else
        // branch below (BUG-FIX-LOG 2026-07-18 follow-up: "multiple blocks").
        console.log(`[api/chat] edit turn was off-topic chat (no patch attempted) @${ms()}ms`);
        displayText = full;
        deliverableHtml = null;
      } else {
        // Either the model attempted an edit (SEARCH markers present) that
        // didn't cleanly apply, or the reply was too malformed/incomplete to
        // trust (truncated patch, or a partial snippet mistaken for a full
        // document) — a genuine failed edit either way, so fall back to ONE
        // full-regeneration call rather than showing raw garbage or a
        // corrupted game. Floor stays "no worse than before this feature
        // existed."
        const reason = patchBadImports.length
          ? `bad_three_imports:${patchBadImports.join("+")}`
          : applied.ok
            ? `incomplete ${applied.mode} output`
            : applied.reason;
        logSearchMiss(full);

        // Option 6 (PRD-RESILIENT-GENERATION §6): try ONE cheap strict-edit rung
        // (4096 tokens) BEFORE the expensive full rebuild (24576 tokens, which
        // regresses parts the child never touched). It's a fresh, small patch
        // against the same source — when it lands cleanly the child keeps their
        // exact game. Anything but a clean, import-safe patch falls through to
        // the unchanged regeneration below. Capped at this single attempt.
        let rescued = false;
        try {
          const rung = await chatModel.strictEditRetry({ currentHtml, message, persona: persona.id, onLedger: mkLedger("strict-edit"), onLoserCost: recordLoser });
          trackTurn(() => recordUsage("chat", servedModel, message, rung.text, false, rung.usage));
          const rungApplied = applyPatch(currentHtml, rung.text);
          const rungBadImports =
            rungApplied.ok && rungApplied.mode === "patch" ? newUnknownThreeImports(currentHtml, rungApplied.html) : [];
          if (rungApplied.ok && rungApplied.mode === "patch" && rungBadImports.length === 0) {
            console.log(`[api/chat] ✓ edit patch (cheap strict rung, before rebuild) @${ms()}ms`);
            displayText = editReplyProse(rung.text);
            deliverableHtml = toDeliverable(rungApplied.html);
            rescued = true;
          } else {
            const why = rungApplied.ok
              ? rungBadImports.length
                ? `bad_imports:${rungBadImports.join("+")}`
                : `mode=${rungApplied.mode}`
              : rungApplied.reason;
            console.log(`[api/chat] cheap strict rung declined (${why}) — full regeneration @${ms()}ms`);
          }
        } catch (err) {
          console.warn(`[api/chat] cheap strict rung unavailable (${(err as Error).message}) — full regeneration @${ms()}ms`);
        }

        if (rescued) {
          // Kept the child's game with a small patch — no rebuild needed.
        } else {
        console.warn(`[api/chat] patch failed (${reason}) — falling back to full regeneration @${ms()}ms`);
        try {
          const fallback = await chatModel.reply({ history, message, image, forceFullRegen: true, persona: persona.id, onLedger: mkLedger("regen"), onLoserCost: recordLoser });
          trackTurn(() => recordUsage("chat", servedModel, message, fallback.text, false, fallback.usage));
          // Same completeness guard as the fresh-build path (BUG-FIX-LOG
          // 2026-07-22): an EDIT that falls back to a full rebuild can be
          // truncated too (owner UAT — "a new chat developed a game but the old
          // chat did not": the old chat was an edit turn, unguarded). If the
          // rebuild is cut off, one compact-complete retry; if it STILL can't
          // finish, never ship a blank game — a friendly retry instead.
          const editGuard = await completeTruncatedBuild(fallback.artifactHtml);
          if (editGuard?.status === "incomplete") {
            deliverableHtml = null;
            displayText = BUILD_INCOMPLETE_RETRY;
          } else {
            const whole = editGuard ? editGuard.reply : fallback;
            // Auto-split: a working starter subset — lead with the "add the rest"
            // offer, same as the fresh-build path.
            if (editGuard?.reduced) {
              displayText = whole.artifactHtml
                ? `${BUILD_STARTER_SPLIT}\n\n\`\`\`html\n${whole.artifactHtml}\n\`\`\``.trim()
                : BUILD_STARTER_SPLIT;
            } else {
              // Honest messaging (penguin-maze hardening): this path REPLACED the
              // child's game — the bare fresh-build default would read as a small
              // targeted change and hide the rebuild that just happened.
              const fallbackProse = whole.artifactHtml && (!whole.text.trim() || whole.text.trim() === FRESH_GAME_LINE)
                ? REBUILT_GAME_LINE
                : whole.text;
              displayText = whole.artifactHtml && !whole.wasFenced
                ? `${fallbackProse}\n\n\`\`\`html\n${whole.artifactHtml}\n\`\`\``.trim()
                : fallbackProse;
            }
            deliverableHtml = toDeliverable(whole.artifactHtml);
          }
        } catch (err) {
          console.error(`[api/chat] ✖ fallback regeneration failed @${ms()}ms: ${(err as Error).message}`);
          send({ type: "error", text: "Oops! Something went wrong. Let's try again." });
          if (replyId) trackTurn(() => turnResults.fail(replyId, userId, Date.now()));
          return;
        }
        }
      }
    } else {
      let { text: prose, artifactHtml, wasFenced } = extractArtifact(full);
      let displaySource = full; // the raw text the wasFenced display path echoes

      // Never ship a game the model reported "done" on but left truncated.
      const guard = await completeTruncatedBuild(artifactHtml);
      if (guard?.status === "incomplete") {
        deliverableHtml = null;
        displayText = BUILD_INCOMPLETE_RETRY;
      } else {
        if (guard) {
          const r = guard.reply;
          prose = r.text; artifactHtml = r.artifactHtml; wasFenced = r.wasFenced ?? false; displaySource = r.text;
          // Auto-split: lead with the "starter version — add the rest" offer, and
          // re-fence the game so that message is what the child reads.
          if (guard.reduced) { prose = BUILD_STARTER_SPLIT; wasFenced = false; displaySource = BUILD_STARTER_SPLIT; }
        }
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
        : displaySource;

      // Three-import lint (BUG-FIX-LOG 2026-07-20 "DoubleSide"): a name the
      // vendored bundle doesn't export kills the game on its import line —
      // dead on arrival, unrepairable by patching. ONE corrective retry
      // naming the exact violation; if it can't produce a clean game, the
      // original is still served (visible + repairable beats dropped).
      const badImports = artifactHtml ? unknownThreeImports(artifactHtml) : [];
      if (badImports.length && artifactHtml) {
        console.warn(`[api/chat] ⛔ unknown three imports: ${badImports.join(", ")} — corrective retry @${ms()}ms`);
        try {
          const corrective = await chatModel.reply({
            history,
            message:
              `${message}\n\n(IMPORTANT: your previous version crashed because it imported ` +
              `${badImports.join(", ")} from "three" — those exports do not exist in this platform's ` +
              `three bundle. Rebuild the game importing ONLY these names from "three": ${CURATED_IMPORT_NAMES.join(", ")}.)`,
            image,
            forceFullRegen: true,
            onLedger: mkLedger("regen"),
          });
          trackTurn(() => recordUsage("chat", servedModel, message, corrective.text, false, corrective.usage));
          if (corrective.artifactHtml && unknownThreeImports(corrective.artifactHtml).length === 0) {
            console.log(`[api/chat] ✓ import-lint corrective retry @${ms()}ms`);
            displayText = !corrective.wasFenced
              ? `${corrective.text}\n\n\`\`\`html\n${corrective.artifactHtml}\n\`\`\``.trim()
              : corrective.text;
            deliverableHtml = toDeliverable(corrective.artifactHtml);
          } else {
            console.warn(`[api/chat] import-lint retry did not come back clean — serving the original @${ms()}ms`);
          }
        } catch (err) {
          console.warn(`[api/chat] import-lint retry unavailable (${(err as Error).message}) — serving the original @${ms()}ms`);
        }
      }
      }
    }
    send({ type: "done", text: displayText, artifactHtml: deliverableHtml, ...(newGamePrompt ? { newGamePrompt: true } : {}) });
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
    console.log(`[api/chat] ✓ shown by ${servedModel}${servedModel === chatModelName ? "" : " (fallback)"} @${ms()}ms`);
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
