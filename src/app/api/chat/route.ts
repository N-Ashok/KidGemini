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
  isGameEditTurn, isThreeConversionTurn, currentGameHtml, editReplyProse, looksLikeAttemptedEdit, looksLikeCompleteDocument, looksTruncatedDocument,
  regenReplyProse, reconcileAssetMarkers, reconcileAssetMarkersWithReason, detectsNewGame, NEW_GAME_PROMPT_LINE, THREE_D_NEW_GAME_LINE,
} from "@/lib/game-edit";
import { stripAssetMarkers } from "@/lib/assets/markers";
import { applyPatch } from "@/lib/repair-prompt";
import { injectAssets } from "@/lib/assets/inject";
import { unrequestedModelSwaps } from "@/lib/assets/model-swap-lint";
import { ensureAssetRuntime } from "@/lib/assets/ensure-runtime";
import { danglingModuleSpecifiers, ensureThreeImports, externalScriptSrcs, newDanglingModuleSpecifiers, newExternalScriptSrcs, newUnknownThreeImports, unknownThreeImports, stripRuntimeGlobalImports } from "@/lib/assets/three-import-lint";
import { findJsSyntaxError } from "@/lib/js-syntax-lint";
import { CURATED_IMPORT_NAMES } from "@/lib/assets/prompt-catalog";
import { ensureMultiplayerMarker } from "@/lib/multiplayer-gate";
import { parseNextAskLine, reclaimLeadingNextAsk } from "@/lib/next-ask-sentinel";
import { buildFallbackNextAskHints, kidHintsEnabled } from "@/lib/next-ask-hints";
import { kidThoughtLine } from "@/lib/kid-thought";
import { trimHistory } from "@/lib/history-trim";
import { RulesClassifier } from "@/lib/safety.rules";
import { KIND_REDIRECT, SPARKS_OVER_LINE, MODEL_GLITCH_RETRY, BUILD_INCOMPLETE_RETRY, BUILD_STARTER_SPLIT, EDIT_FAILED_SOFT, adultSafetyBlockMessage } from "@/lib/chat-copy";
import { SqliteAlertStore, SqliteUsageStore, SqliteRateLimitStore, SqliteTurnResultStore, SqliteScreenTimeStore } from "@/lib/db";
import { resolveGeo } from "@/lib/geo";
import { estimateCostUsd } from "@/lib/pricing.config";
import { getAriantraSession } from "@/lib/ariantra-session.server";
import { SESSION_COOKIE } from "@/lib/ariantra-session";
import { billSparks, fetchGate } from "@/lib/sparks-bridge";
import { catalogGates } from "@/lib/assets/catalog-gate";
import { resolvePersona } from "@/lib/persona/persona";
import { GUEST_ASK_LIMIT, GUEST_COOKIE, GUEST_COOKIE_LEGACY, GUEST_COOKIE_MAX_AGE_S, GUEST_WINDOW_MS, ipGuestTokenCap, guestTokenLimitFor, signedInDailyTokenLimit } from "@/lib/gate.config";
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
  let body: { message?: string; attachmentText?: string; attachmentName?: string; history?: ChatMessage[]; image?: unknown; replyId?: unknown; activeGameMessageId?: unknown; forceRebuild?: unknown; differentVersion?: unknown; persona?: unknown };
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

  // KNOWN_BUGS #7/#12 (2026-07-27): a re-attached text file that isn't a
  // complete HTML document used to get folded, whole, into `message` by the
  // client — so a ~100K-char game body could get scanned by the safety rules
  // as if it were typed child speech. The client now sends the child's own
  // typed text separately from any attachment content; `childText` is what
  // the safety scan sees, `message` (reconstructed here, same shape as the
  // client used to build) is what the model sees — model behavior unchanged,
  // only the safety-scanned string changed.
  const childText = (body.message ?? "").trim();
  const attachmentText = typeof body.attachmentText === "string" ? body.attachmentText : undefined;
  const attachmentName = typeof body.attachmentName === "string" ? body.attachmentName : undefined;
  const message = attachmentText
    ? `The child attached a file named "${attachmentName ?? "file"}". Its contents:\n\`\`\`\n${attachmentText}\n\`\`\`\n\n${childText || "Please take a look at this file."}`
    : childText;
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
      const ipCap = ipGuestTokenCap(); // shipped 20,000; env-tunable per request
      const ipUsed = usage.guestTokensUsedByIp(geo.ip, Date.now() - GUEST_WINDOW_MS);
      if (ipUsed >= ipCap) {
        console.log(`[api/chat] ⛔ gate: ip=${geo.ip} used=${ipUsed}/${ipCap} → 401`);
        return NextResponse.json(
          { error: "auth_required", reason: "ip_limit",
            message: "Please sign in to continue using Ari ✨" },
          { status: 401, headers: guestCookieHeader(setGuestCookie) },
        );
      }
    }

    // Owner funnel 2026-08-08: on the DEFAULT surface a guest gets exactly
    // ONE real ask — the game builds (its preview locks behind sign-in
    // client-side), and the next ask walls here. Ask count, not tokens: the
    // token tally counts only visible text and undercounted real spend ~13×
    // (live measure 2026-08-08: one guest session = 70K real tokens ≈ 1,131⚡
    // vs 5.5K counted). The bible-teacher surface keeps its own token trial
    // (PRD §3a); the per-IP token cap above backstops serial-incognito.
    if (requestedPersona !== "bible-teacher") {
      const asks = usage.chatTurnsByUser(guestId, Date.now() - GUEST_WINDOW_MS);
      console.log(`[api/chat] guest ${guestId} asks=${asks}/${GUEST_ASK_LIMIT}`);
      if (asks >= GUEST_ASK_LIMIT) {
        console.log(`[api/chat] ⛔ gate: guest one-ask limit → 401 sign-in wall`);
        return NextResponse.json(
          { error: "auth_required", reason: "guest_limit",
            message: "Your game is waiting! Sign in free to see it, keep it forever, and get 2,000 free Sparks to keep building ✨" },
          { status: 401, headers: guestCookieHeader(setGuestCookie) },
        );
      }
    }

    // The bible-teacher surface gets a SMALLER free trial (PRD §3a) before the
    // sign-in + adult gate; every other surface keeps a token VOLUME belt
    // behind the one-ask rule.
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
      // Record the persona so a per-persona, per-model failure rate is a one-line
      // ledger query (owner ask 2026-07-23: is a single model the one that keeps
      // safety-blocking bible-teacher builds? then swap it for that persona).
      persona: persona.id,
      chain: summary.chain, attempts: summary.attempts, winner: summary.winner,
      calls: summary.attempts.length,
    });

  // Gemini bills a small fixed token count per image tile (~258 for our ≤1024px
  // uploads) — count it so the guest gate can't be bypassed with picture spam.
  const IMAGE_PROMPT_TOKENS = 258;

  // promptTokens/outputTokens stay char-estimates — the guest/daily gates are
  // tuned to them. `real` (Gemini usageMetadata, when the stream delivered it)
  // fills the billed* columns and prices all 4 billed token types.
  // Sparks (platform PRD-SPARKS): signed-in kids' turns bill the platform
  // ledger from the SAME measured numbers the dashboard uses. Guests aren't
  // billed (no platform account); safety/moderation calls are OUR overhead,
  // never the child's. Fire-and-forget — billing must never slow a turn.
  const sparksToken = signedIn ? req.cookies.get(SESSION_COOKIE)?.value ?? "" : "";
  let sparksSeq = 0;
  // 3D pricing (platform repo docs/PRD-SPARKS.md 3D pricing amendment): the
  // SAME pure predicate configFor() uses internally to gate the 3D asset
  // catalog (gemini.ts's `gates.three`, paid:false hardwired until
  // entitlement lands — TECH_DEBT #11) — kept in lock-step by calling the
  // same exported function here, not by threading a value through the
  // generation pipeline. Re-detects 3D-ness on an EDIT via the prior
  // artifact's Three.js markers, not just this turn's message text, so
  // editing an existing 3D game bills at the 3D rate too.
  const is3D = catalogGates({ message, history, paid: false }).three;
  function billTurnSparks(kind: string, model: string, promptTokens: number, outputTokens: number, real: TokenUsage | null | undefined, costUsd: number) {
    if (!sparksToken || kind === "safety") return;
    billSparks({
      sessionToken: sparksToken,
      replyId: replyId ?? "no-reply-id",
      seq: sparksSeq++,
      kind,
      is3D,
      usage: {
        model,
        tokensIn: real?.promptTokens ?? promptTokens,
        tokensOut: (real?.outputTokens ?? outputTokens) + (real?.thoughtTokens ?? 0),
        tokensCached: real?.cachedTokens,
        costUsd,
      },
    });
  }

  function recordUsage(
    kind: "chat" | "safety", model: string, requestText: string, outputText: string,
    blocked: boolean, real?: TokenUsage | null,
  ) {
    const promptTokens = estTokens(requestText) + (image && kind === "chat" ? IMAGE_PROMPT_TOKENS : 0);
    const outputTokens = estTokens(outputText);
    const costUsd = estimateCostUsd(model, {
      prompt: real?.promptTokens ?? promptTokens,
      output: real?.outputTokens ?? outputTokens,
      thoughts: real?.thoughtTokens,
      cached: real?.cachedTokens,
    });
    usage.record({
      userId, userLabel, model, kind, promptTokens, outputTokens,
      userAgent: req.headers.get("user-agent"),
      billedPromptTokens: real?.promptTokens,
      billedOutputTokens: real?.outputTokens,
      thoughtTokens: real?.thoughtTokens,
      cachedTokens: real?.cachedTokens,
      costUsd,
      geo, requestText, outputText, blocked,
    });
    billTurnSparks(kind, model, promptTokens, outputTokens, real, costUsd);
  }
  function alert(origin: "child" | "model", triggerText: string, v: SafetyVerdict) {
    // Scope to the child's account so ONLY their parent sees it, never another
    // family (PRD-PARENT-AUTH-ALERT-SCOPING §8 Phase 2). userId is the SSO
    // family account (user:<email>) for a signed-in child, else the guest id.
    alerts.record({ accountId: userId, origin, category: v.category, severity: v.severity, action: v.action, triggerText, reason: v.reason });
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
      const costUsd = estimateCostUsd(model, {
        prompt: real?.promptTokens ?? promptTokens,
        output: real?.outputTokens ?? outputTokens,
        thoughts: real?.thoughtTokens,
        cached: real?.cachedTokens,
      });
      usage.record({
        userId, userLabel, model, kind: "fallback", promptTokens, outputTokens,
        userAgent: req.headers.get("user-agent"),
        billedPromptTokens: real?.promptTokens,
        billedOutputTokens: real?.outputTokens,
        thoughtTokens: real?.thoughtTokens,
        cachedTokens: real?.cachedTokens,
        costUsd,
        geo, requestText: message, outputText, blocked: false,
      });
      billTurnSparks("fallback", model, promptTokens, outputTokens, real, costUsd);
      console.log(`[api/chat] 💸 billed losing call ${model} (kind=fallback, ${outputTokens} out tok) @${ms()}ms`);
    } catch { /* bookkeeping must never break a turn */ }
  }

  // ── 1. INPUT: instant deterministic check (no LLM latency) ────────────────
  // Scans childText ONLY — never the reconstructed `message`, which can carry
  // an attached file's full contents (KNOWN_BUGS #7/#12: that used to be what
  // got scanned, and an oversized attachment could false-positive the rules).
  const inRules = rules.classifySync({ text: childText, origin: "child" });
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
    if (persona.inputRuleMode !== "adult") alert("child", childText, inRules);
    return ndjson((send) => {
      send({ type: "blocked", text: KIND_REDIRECT });
    }, guestCookieHeader(setGuestCookie));
  }

  // ── 1b. 2D→3D conversion = a NEW game (owner decision 2026-07-26,
  // supersedes the in-place rebuild of BUG-FIX-LOG 2026-07-23): converting
  // throws away the 2D code anyway, so it is a second game, not an edit.
  // Answer instantly — no model call, nothing billed — with the info line +
  // threeDNewGame flag; the client shows the one-button OK panel, then starts
  // the build in a fresh chat seeded with the 2D game and sends it with
  // forceRebuild, which skips this guard. The 2D game is never touched.
  if (!forceRebuild && isThreeConversionTurn(message, history, activeGameMessageId)) {
    console.log(`[api/chat] 🎮 2D→3D conversion — a new game, offering fresh chat @${ms()}ms`);
    return ndjson((send) => {
      send({ type: "done", text: THREE_D_NEW_GAME_LINE, artifactHtml: null, threeDNewGame: true });
    }, guestCookieHeader(setGuestCookie));
  }

  // ── 1c. Sparks exhaustion gate (2026-08-07, platform PRD-SPARKS trial
  // amendment). Runs AFTER the free refusals (safety, 3D-conversion) and
  // BEFORE anything billable: an exhausted kid's in-flight reply already
  // completed (debits are post-usage — nothing here can cut a stream); the
  // NEXT turn is refused with the buy-Sparks line, and the client locks the
  // preview off the same event (`sparksOver`). Fail OPEN on a platform
  // hiccup: a Sparks outage must never stop a kid's turn (mirror of
  // billSparks's fire-and-forget stance; money is protected fail-CLOSED at
  // the order route instead). Guests never bill, so they are never gated.
  if (sparksToken) {
    const gate = await fetchGate(sparksToken);
    if (gate.status === 200 && gate.data.canStart === false) {
      console.log(`[api/chat] ⚡ sparks exhausted — turn refused @${ms()}ms`);
      return ndjson((send) => {
        send({ type: "paywall", text: SPARKS_OVER_LINE, sparksOver: true });
      }, guestCookieHeader(setGuestCookie));
    }
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
      // nextAsk is an EXPLICIT opt-in, deliberately set ONLY on this one true
      // primary stream — never on any retry/regeneration one-shot below
      // (BUG-FIX-LOG 2026-07-28: see gemini.ts's configFor for why those must
      // never inherit it, even when the flag is on).
      for await (const chunk of chatModel.replyStream({ history, message, image, activeGameMessageId, forceRebuild, preferAlternateModel, persona: persona.id, onLedger: mkLedger("chat"), nextAsk: kidHintsEnabled() })) {
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
        // A verified-adult teacher gets an HONEST, actionable explanation (they
        // can act on the truth); a kid gets the gentle retry redirect (owner ask
        // 2026-07-23). Copy only — no safety posture change.
        const blockedText =
          persona.inputRuleMode === "adult" ? adultSafetyBlockMessage(err.safetyInfo) : MODEL_GLITCH_RETRY;
        send({ type: "blocked", text: blockedText });
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
        //
        // ensureAssetRuntime is the marker-INDEPENDENT floor (BUG-FIX-LOG
        // 2026-07-23): if the model imported "three" but mis-placed/omitted the
        // <!--USES_THREE--> marker, injectAssets no-ops and the game would ship
        // with an unresolvable specifier. The floor guarantees the import map
        // regardless; it's idempotent on already-injected HTML.
        // ensureThreeImports (BUG-FIX-LOG 2026-08-07): a used-but-not-imported
        // three name (`new PointLight(...)` missing from the import list) is a
        // play-time ReferenceError the verify pass can't see — heal it
        // deterministically; byte-identical when nothing is missing.
        // stripRuntimeGlobalImports (BUG-FIX-LOG 2026-08-08) runs FIRST: a
        // runtime helper wrongly imported from "three" (loadModel…) is a dead
        // import line, and dropping it here retires the ~50s corrective retry
        // that used to be the only cure.
        return ensureMultiplayerMarker(ensureAssetRuntime(ensureThreeImports(stripRuntimeGlobalImports(injected.html))));
      } catch (err) {
        console.error(`[api/chat] ✖ asset injection failed @${ms()}ms (serving raw artifact): ${(err as Error).message}`);
        return ensureMultiplayerMarker(ensureAssetRuntime(ensureThreeImports(stripRuntimeGlobalImports(rawHtml))));
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
    // Kid hints / next-ask chips (2026-07-28 PRD): the model's own contextual
    // suggestions, parsed out of the fresh-build branch below. Stays undefined
    // on an edit/patch turn (never requested there — next-ask-sentinel.ts) or
    // when the model's sentinel line was missing/malformed; the fallback pool
    // fills the gap right before `send`, so a kid only ever gets zero chips
    // when the flag is off entirely.
    let nextAskHints: string[] | undefined;

    // Patch-based feature edits (BUG-FIX-LOG class fix, 2026-07-18): a
    // follow-up request on an already-good game is answered with a targeted
    // SEARCH/REPLACE patch — the same minimal-patch contract the self-healing
    // repair flow already uses (repair-prompt.ts's applyPatch) — instead of a
    // full-file regeneration, so parts the child never asked to change can't
    // silently regress.
    // forceRebuild ("Change this one ✏️", PRD §11) skips this whole path — the
    // child already consented to rebuild the new game in place, so it takes the
    // ordinary fresh-build branch below.
    // A 2D→3D conversion skips the patch path entirely and rebuilds (BUG-FIX-LOG
    // 2026-07-23): gemini.ts streamed this turn in full-rebuild mode (same
    // isThreeConversionTurn predicate), so `full` is a whole 3D game, not a patch —
    // fall through to the fresh-build branch that extracts it.
    if (!forceRebuild && !isThreeConversionTurn(message, history, activeGameMessageId) && isGameEditTurn(message, history, activeGameMessageId)) {
      // Kid hints on EDIT turns (owner approval 2026-07-28): the model appends
      // one trailing NEXT_ASKS line after the patch blocks
      // (NEXT_ASK_EDIT_PROMPT_SECTION). Strip it off the RAW reply here, before
      // ANY of the edit machinery reads it — applyPatch, detectsNewGame,
      // looksLikeAttemptedEdit, logSearchMiss, reconcileAssetMarkers and
      // editReplyProse all take `full`, so cleaning it once at the top keeps
      // every one of them on byte-identical input to what they saw before this
      // feature existed. (Each is independently immune to a trailing line —
      // see NEXT_ASK_EDIT_PROMPT_SECTION — but not depending on that is
      // cheaper than relying on it.)
      if (kidHintsEnabled()) {
        const parsed = parseNextAskLine(full);
        if (parsed) {
          nextAskHints = parsed.ideas;
          full = parsed.cleanedText;
        }
      }
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
        // KNOWN_BUGS #5 closeout Step 0 (2026-07-27): self-classify the REMAINING
        // misses (afterMarkerStrip=false) so a single prod occurrence is
        // conclusive. searchSpansHead=true + afterMarkerStrip=false is the
        // documented head-spanning residual (marker-strip alone can't reconcile a
        // SEARCH that also covers the injected importmap/AR_ASSETS <head>
        // content); reconcileBailed pins WHY reconcileAssetMarkers gave up at all.
        const searchSpansHead = /<head|type="importmap"|AR_ASSETS/i.test(firstSearch);
        const reason = reconcileAssetMarkersWithReason(currentHtml, reply);
        const reconcileBailed = "bailed" in reason ? reason.bailed : "rescued";
        console.warn(
          `[api/chat]   first SEARCH head: "${head}" inSource=${inSource} afterMarkerStrip=${afterMarkerStrip} searchSpansHead=${searchSpansHead} reconcileBailed=${reconcileBailed}`,
        );
      };
      let applied = applyPatch(currentHtml, full);
      // inSource=false rescue (KNOWN_BUGS #5): the model re-emitted asset markers
      // injectAssets had stripped from the stored game, so its SEARCH can't be
      // found. Reconcile them out (guarded — only when it can't regress a new
      // asset) and re-apply BEFORE escalating to a full regeneration.
      if (!applied.ok && applied.reason === "search_not_found") {
        const reconciled = reconcileAssetMarkersWithReason(currentHtml, full);
        if ("html" in reconciled) {
          const retry = applyPatch(currentHtml, reconciled.html);
          if (retry.ok) {
            // An edit that ADDS an asset keeps its marker literals — appended
            // to the PATCHED html so injectAssets injects the addition and
            // merges it with the names it reclaims from the previous
            // AR_ASSETS table (BUG-FIX-LOG 2026-08-08). Empty for an edit that
            // adds nothing, so the common case stays byte-identical.
            applied = reconciled.markers ? { ...retry, html: retry.html + reconciled.markers } : retry;
            console.log(
              `[api/chat] ✓ edit patch after asset-marker reconciliation${reconciled.markers ? " (+new assets)" : ""} @${ms()}ms`,
            );
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
      // Pipeline-bypass lint (BUG_LOG 2026-08-09 "Calvin"): same reasoning one
      // step out — a patch that INTRODUCES an off-origin <script src> pulls the
      // game off the vendored engine onto someone else's CDN, which is how a
      // three r128 build reached a kid and died on CapsuleGeometry. Judged on
      // what the patch ADDED, so a stored CDN game stays editable.
      const patchBadScripts =
        applied.ok && applied.mode === "patch" ? newExternalScriptSrcs(currentHtml, applied.html) : [];
      if (patchBadScripts.length) {
        console.warn(`[api/chat] ⛔ patch introduces external scripts: ${patchBadScripts.join(", ")} @${ms()}ms`);
      }
      // Same class, relative form: a patch that imports a file which will never
      // exist at play time (`./main.js`) kills the module the same way.
      const patchBadModules =
        applied.ok && applied.mode === "patch" ? newDanglingModuleSpecifiers(currentHtml, applied.html) : [];
      if (patchBadModules.length) {
        console.warn(`[api/chat] ⛔ patch introduces dangling module imports: ${patchBadModules.join(", ")} @${ms()}ms`);
      }
      // Unrequested-model-swap lint (BUG_LOG 2026-08-17, "Mumbai Flight
      // Simulator"): every lint above asks whether the patch still RUNS. This
      // one asks whether it is still the child's GAME. A clean patch that drops
      // the aeroplane twenty turns of work were built around — because the
      // model liked another mesh better — is a failed edit, and takes the same
      // strict-retry path as a bad import.
      const patchModelSwaps =
        applied.ok && applied.mode === "patch"
          ? unrequestedModelSwaps({ before: currentHtml, after: applied.html, message })
          : [];
      if (patchModelSwaps.length) {
        console.warn(`[api/chat] ⛔ patch drops models the child never asked to change: ${patchModelSwaps.join(", ")} @${ms()}ms`);
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
      } else if (
        applied.ok &&
        applied.mode === "patch" &&
        patchBadImports.length === 0 &&
        patchBadScripts.length === 0 &&
        patchBadModules.length === 0 &&
        patchModelSwaps.length === 0
      ) {
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
          : patchBadScripts.length
            ? `external_scripts:${patchBadScripts.join("+")}`
            : patchBadModules.length
            ? `dangling_modules:${patchBadModules.join("+")}`
            : patchModelSwaps.length
            ? `unrequested_model_swap:${patchModelSwaps.join("+")}`
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
          // The cheap rung must close the SAME gates the patch path just closed
          // — without these it can re-introduce the exact bypass rejected one
          // branch earlier and ship it (review finding, 2026-08-09).
          const rungBadBypass =
            rungApplied.ok && rungApplied.mode === "patch"
              ? [
                  ...newExternalScriptSrcs(currentHtml, rungApplied.html),
                  ...newDanglingModuleSpecifiers(currentHtml, rungApplied.html),
                ]
              : [];
          if (rungBadBypass.length) {
            console.warn(`[api/chat] ⛔ strict rung introduces a pipeline bypass: ${rungBadBypass.join(", ")} @${ms()}ms`);
          }
          // Same gate as the patch path above (BUG_LOG 2026-08-17): without it
          // the cheap rung is a second, unguarded door for the very swap the
          // branch before just rejected.
          const rungModelSwaps =
            rungApplied.ok && rungApplied.mode === "patch"
              ? unrequestedModelSwaps({ before: currentHtml, after: rungApplied.html, message })
              : [];
          if (rungModelSwaps.length) {
            console.warn(`[api/chat] ⛔ strict rung drops models the child never asked to change: ${rungModelSwaps.join(", ")} @${ms()}ms`);
          }
          if (
            rungApplied.ok &&
            rungApplied.mode === "patch" &&
            rungBadImports.length === 0 &&
            rungBadBypass.length === 0 &&
            rungModelSwaps.length === 0
          ) {
            console.log(`[api/chat] ✓ edit patch (cheap strict rung, before rebuild) @${ms()}ms`);
            displayText = editReplyProse(rung.text);
            deliverableHtml = toDeliverable(rungApplied.html);
            rescued = true;
          } else {
            const why = rungApplied.ok
              ? rungBadImports.length
                ? `bad_imports:${rungBadImports.join("+")}`
                : rungBadBypass.length
                  ? `pipeline_bypass:${rungBadBypass.join("+")}`
                  : rungModelSwaps.length
                    ? `unrequested_model_swap:${rungModelSwaps.join("+")}`
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
          // Owner decision 2026-08-10 ("fail softly", after the fallback
          // regeneration replaced the 89-message AutoRicksaw city — "The
          // whole game changed and it is pathetic"): a failed or rejected
          // edit patch must NEVER rebuild the game from scratch. For a
          // long-lived game the regeneration IS the destruction — the old
          // "no worse than before edits existed" floor was written when the
          // floor was a fresh build. Keep the child's game untouched, say so
          // honestly, and invite a rephrase. The regen path (with its own
          // truncation guard) still exists for FRESH builds only.
          console.warn(`[api/chat] patch failed (${reason}) — soft-fail, game untouched @${ms()}ms`);
          displayText = EDIT_FAILED_SOFT;
          deliverableHtml = null;
        }
      }
    } else {
      // Kid hints / next-ask chips: strip the model's trailing NEXT_ASKS
      // sentinel out of the RAW reply BEFORE extractArtifact ever sees it, so
      // both the extracted prose AND the raw wasFenced-display path
      // (`displaySource` below) stay sentinel-free — extracting from `prose`
      // alone would miss it on the wasFenced path, which echoes `full`
      // verbatim rather than reconstructing from `prose`. Only trusted when
      // the code fence still closes cleanly AFTER stripping the line — that
      // guarantees the sentinel was genuinely tacked on after the fence
      // closed, not embedded inside the game/HTML itself (an unclosed/bare
      // reply is left completely untouched).
      let workingFull = full;
      if (kidHintsEnabled()) {
        // BUG-FIX-LOG 2026-08-13: a second placement failure — the model can
        // also put the sentinel at the very START of the reply, before the
        // fence opens. Move it to the end FIRST (no-op when it's already
        // trailing, or absent) so the trailing-only logic below recovers it
        // exactly as if the model had followed the instruction the first time.
        const normalizedFull = reclaimLeadingNextAsk(full);
        const parsed = parseNextAskLine(normalizedFull);
        if (parsed && extractArtifact(parsed.cleanedText).wasFenced) {
          workingFull = parsed.cleanedText;
          nextAskHints = parsed.ideas;
        }
      }

      let { text: prose, artifactHtml, wasFenced } = extractArtifact(workingFull);
      let displaySource = workingFull; // the raw text the wasFenced display path echoes

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
      //
      // Pipeline-bypass lint (BUG_LOG 2026-08-09 "Calvin"): the mirror case —
      // a game that never joined the contract AT ALL, so the lint above has no
      // import statement to inspect and passes it. Calvin's did exactly that:
      // `<script src=".../three.js/r128/three.min.js">` off cdnjs plus global
      // `THREE.*` calls. r128 predates CapsuleGeometry, so it threw on the line
      // building his own character and rendered nothing.
      //
      // Folded into the SAME retry rather than a second sequential one on
      // purpose: Calvin had already waited ~70s through a model stub and a
      // truncation recovery before this point, and a second corrective round
      // would have added another full regeneration to that.
      const badImports = artifactHtml ? unknownThreeImports(artifactHtml) : [];
      const badScripts = artifactHtml ? externalScriptSrcs(artifactHtml) : [];
      const badModules = artifactHtml ? danglingModuleSpecifiers(artifactHtml) : [];
      // Deterministic pre-delivery syntax check (owner ask 2026-08-13, after a
      // real generated game crashed on load with `Invalid or unexpected
      // token` — nothing in the pipeline caught it before the kid saw a
      // broken game). A parse costs single-digit milliseconds (measured:
      // ~16ms on a real 58KB game) — negligible next to the model call
      // already happening. Folded into the SAME corrective retry as the
      // import/script lints above, not a separate sequential one (Calvin
      // precedent, 2026-08-09) — the kid has already waited through a full
      // generation by this point.
      const syntaxError = artifactHtml ? findJsSyntaxError(artifactHtml) : null;
      if ((badImports.length || badScripts.length || badModules.length || syntaxError) && artifactHtml) {
        if (badImports.length) {
          console.warn(`[api/chat] ⛔ unknown three imports: ${badImports.join(", ")} — corrective retry @${ms()}ms`);
        }
        if (badScripts.length) {
          console.warn(`[api/chat] ⛔ external scripts (pipeline bypass): ${badScripts.join(", ")} — corrective retry @${ms()}ms`);
        }
        if (badModules.length) {
          console.warn(`[api/chat] ⛔ dangling module imports (pipeline bypass): ${badModules.join(", ")} — corrective retry @${ms()}ms`);
        }
        if (syntaxError) {
          console.warn(`[api/chat] ⛔ JS syntax error: ${syntaxError.message} — corrective retry @${ms()}ms`);
        }
        // Is this actually a 3D game? A bad three-import proves it; otherwise
        // look for the marker or a three usage in the artifact. A 2D game that
        // merely loaded some other library off a CDN must NOT be rebuilt in 3D.
        const isThreeGame =
          badImports.length > 0 || /USES_THREE|from\s*['"]three['"]|\bTHREE\s*\./.test(artifactHtml);
        const faults = [
          badImports.length
            ? `it imported ${badImports.join(", ")} from "three" — those exports do not exist in this platform's three bundle`
            : "",
          badScripts.length
            ? `it loaded a third-party library with a <script src> tag (${badScripts.join(", ")}) — this platform serves its OWN three.js build, and that external copy is an OLD version missing things your code called`
            : "",
          badModules.length
            ? `it imported ${badModules.join(", ")} — those files do not exist; a game is ONE self-contained HTML document, and the ONLY module specifier that resolves is the bare "three"`
            : "",
          syntaxError
            ? `it has a JavaScript syntax error and never even parses: ${syntaxError.message}${syntaxError.line ? ` (around line ${syntaxError.line})` : ""} — check every string is closed, every brace/paren is matched, and no statement was cut off mid-way`
            : "",
        ].filter(Boolean);
        try {
          const corrective = await chatModel.reply({
            history,
            // The remedy must match the violation. `badScripts` fires for ANY
            // off-origin script — a 2D game that pulled Tone.js off a CDN is a
            // real hit — and the 3D half of this instruction would tell that
            // game to rebuild itself as a three.js game, injecting a 635 KB
            // engine it doesn't need and marking it 3D for every later turn
            // (review finding, 2026-08-09). Only add the 3D contract when this
            // game is actually 3D.
            message:
              `${message}\n\n(IMPORTANT: your previous version crashed because ${faults.join(", and ")}. ` +
              `Rebuild the game as ONE self-contained HTML document with NO \`<script src="...">\` tags of ` +
              `any kind — put the game's own code inline.` +
              (isThreeGame
                ? ` Because this is a 3D game: put \`<!--USES_THREE-->\` as the first thing inside \`<body>\`, ` +
                  `write the game inside \`<script type="module">\`, and import ONLY these names from "three": ` +
                  `${CURATED_IMPORT_NAMES.join(", ")}.`
                : "") +
              `)`,
            image,
            forceFullRegen: true,
            onLedger: mkLedger("regen"),
          });
          trackTurn(() => recordUsage("chat", servedModel, message, corrective.text, false, corrective.usage));
          if (
            corrective.artifactHtml &&
            unknownThreeImports(corrective.artifactHtml).length === 0 &&
            externalScriptSrcs(corrective.artifactHtml).length === 0 &&
            danglingModuleSpecifiers(corrective.artifactHtml).length === 0 &&
            !findJsSyntaxError(corrective.artifactHtml)
          ) {
            console.log(`[api/chat] ✓ import-lint corrective retry @${ms()}ms`);
            displayText = !corrective.wasFenced
              ? `${corrective.text}\n\n\`\`\`html\n${corrective.artifactHtml}\n\`\`\``.trim()
              : corrective.text;
            deliverableHtml = toDeliverable(corrective.artifactHtml);
          } else {
            // NEVER serve an artifact with an unknown three import (2026-08-16).
            //
            // This branch used to fall through to "serving the original", and
            // on 2026-08-16 that put a DEAD game in a child's hands: the build
            // imported CatmullRomCurve3, the lint caught it, the corrective
            // retry produced it again, and we shipped it anyway. A missing
            // export is not a risk — it is a PARSE error, so the module never
            // runs, every function inside it is undefined, and the Start
            // button does nothing. The child's console showed
            // "does not provide an export named 'CatmullRomCurve3'" followed
            // by "startGame is not defined".
            //
            // Nothing is better than that. A child who is told the build
            // tangled and to try again has lost a minute; a child handed a
            // game that cannot start loses their trust in the thing that
            // said "here you go!".
            // FATAL vs SURVIVABLE — the distinction matters, and getting it
            // wrong in either direction hurts a child.
            //
            // An unknown three import, a dangling module specifier or a syntax
            // error are all PARSE/RESOLVE failures: the module never executes,
            // every function in it is undefined, and the Start button does
            // nothing. There is no version of that a child can play or repair.
            //
            // An external <script src> is NOT in that class: the game very
            // likely still runs (an old CDN three.js is worse than ours, not
            // fatal), so the long-standing contract — "visible + repairable
            // beats dropped", pinned by XS.2 — still holds for it.
            const stillBadImports = corrective.artifactHtml
              ? unknownThreeImports(corrective.artifactHtml)
              : badImports;
            const stillBadModules = corrective.artifactHtml
              ? danglingModuleSpecifiers(corrective.artifactHtml)
              : badModules;
            const stillSyntax = corrective.artifactHtml
              ? findJsSyntaxError(corrective.artifactHtml)
              : syntaxError;
            const fatal = stillBadImports.length > 0 || stillBadModules.length > 0 || Boolean(stillSyntax);
            if (fatal) {
              console.warn(
                `[api/chat] ⛔ retry STILL fatal (${[...stillBadImports, ...stillBadModules, stillSyntax?.message].filter(Boolean).join(", ")}) — refusing to serve a game that cannot parse @${ms()}ms`,
              );
              displayText = MODEL_GLITCH_RETRY;
              deliverableHtml = null;
            } else {
              console.warn(`[api/chat] import-lint retry did not come back clean — serving the original @${ms()}ms`);
            }
          }
        } catch (err) {
          console.warn(`[api/chat] import-lint retry unavailable (${(err as Error).message}) — serving the original @${ms()}ms`);
        }
      }
      }
    }

    // Kid hints / next-ask chips — final defensive pass. The primary parse
    // above only covers the main fresh-build reply; several secondary retry
    // paths (truncation recovery, the import-lint corrective retry, and the
    // edit branch's own forceFullRegen fallback) can ALSO carry a
    // model-generated NEXT_ASKS line, since forceFullRegen turns are treated
    // as fresh-build turns by gemini.ts's configFor (isEdit=false) and can
    // still receive the prompt section. Rather than instrument every one of
    // those branches individually, catch any stray trailing sentinel on the
    // FINAL displayText here — parseNextAskLine is strict and side-effect-free,
    // so this is a safe no-op on ordinary chat text. Falls back to the static
    // pool (next-ask-hints.ts) only for a genuine game turn (deliverableHtml
    // set) that still has no hints — never on a refusal/clarification/new-game
    // prompt turn, so suggestion chips never sit under a non-answer.
    if (kidHintsEnabled()) {
      const trailing = parseNextAskLine(displayText);
      if (trailing) {
        displayText = trailing.cleanedText;
        if (!nextAskHints) nextAskHints = trailing.ideas;
      }
      if (!nextAskHints && deliverableHtml) {
        nextAskHints = buildFallbackNextAskHints(persona.id === "bible-teacher" ? "bible-teacher" : undefined);
      }
      // Invariant: chips only ever accompany a REAL game. An edit turn that
      // turned out to be off-topic chat (no patch attempted, no game delivered)
      // can still have carried a parsed sentinel — game-change suggestions
      // under a plain conversational reply would make no sense.
      if (!deliverableHtml) nextAskHints = undefined;
    }

    send({
      type: "done",
      text: displayText,
      artifactHtml: deliverableHtml,
      ...(newGamePrompt ? { newGamePrompt: true } : {}),
      ...(nextAskHints ? { nextAskHints } : {}),
    });
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
