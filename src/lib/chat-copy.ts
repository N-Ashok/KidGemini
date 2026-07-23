// Kid-facing copy for the two DISTINCT block cases on /api/chat. Lives here (not
// in route.ts) because a Next App Router route file may only export request
// handlers + framework config — exporting these constants from the route broke
// the build (`.next/types` OmitWithTag), and the route's test needs to import
// them. A lib module is the right home for shared copy anyway (SOLID: the route
// handles requests; copy is data).

// A genuine INPUT block — the child actually typed something we won't engage
// with (profanity/self-harm/PII, safety.rules.ts). A gentle topic change is
// right here: don't invite them to rephrase the thing we blocked.
export const KIND_REDIRECT =
  "Let's talk about something else! How about a fun fact, a story, or a game? 🌟";

// A MODEL false-positive — the request was fine (input rules allowed it) but the
// provider's own safety layer blocked the generation (finishReason SAFETY). We
// own the hiccup AND give an actionable HINT: adding a little context (what the
// game is about + who it's for) is exactly what clears these false-positives —
// verified live 2026-07-22, "add Jesus…" blocked bare but generated with "for a
// kids educational game" framing. So we guide the user to rephrase productively
// instead of a vague "say it another way" (owner call 2026-07-22; keeps the
// strict safety threshold — the fix is guidance, not a weaker filter).
export const MODEL_GLITCH_RETRY =
  "Hmm, that one tangled me up! Try telling me a bit more — what your game is about and who it's for — and I'll build it. ✨";

// The build was CUT OFF before it finished (the model returned "done" on a
// half-written game) AND a corrective retry couldn't finish it either. We never
// publish a blank/truncated game (BUG-FIX-LOG 2026-07-22) — so instead of a dead
// artifact, invite a retry and nudge toward a smaller ask that won't overflow.
export const BUILD_INCOMPLETE_RETRY =
  "Oof — that one got too big for me to finish in one go! 😅 Tap try again, or ask for it in two steps: the game first, then the details (like the full list of characters).";

// ── Teacher mode (verified-adult bible-teacher persona) block copy ──────────
// A kid gets the gentle MODEL_GLITCH_RETRY redirect. An ADULT author does NOT
// benefit from a vague "tell me more" — they can act on the truth (owner ask
// 2026-07-23: "in adult mode, an honest answer would help find solutions"). So
// a teacher-mode provider safety block gets an HONEST explanation plus a
// concrete way forward, naming the tripped category when the provider reported
// one. This is copy only — no safety posture changes here.

const FRIENDLY_CATEGORY: Record<string, string> = {
  HARASSMENT: "harassment",
  HATE_SPEECH: "hate speech",
  SEXUALLY_EXPLICIT: "sexual content",
  DANGEROUS_CONTENT: "dangerous content",
};

/** From a safetyInfo summary ("HARASSMENT:MEDIUM, HATE_SPEECH:LOW(blocked)"),
 *  the human-friendly names of the categories that actually tripped the block —
 *  anything marked (blocked) or rated MEDIUM/HIGH. Empty when nothing stands
 *  out (e.g. only LOW/NEGLIGIBLE ratings), so the message stays generic. */
export function blockedCategoryNames(safetyInfo?: string): string[] {
  if (!safetyInfo) return [];
  const out: string[] = [];
  for (const part of safetyInfo.split(",")) {
    const m = part.trim().match(/^([A-Z_]+):([A-Z]+)(\(blocked\))?/i);
    if (!m) continue;
    const [, cat, prob, blocked] = m;
    if (!cat || !prob) continue;
    const notable = Boolean(blocked) || ["MEDIUM", "HIGH"].includes(prob.toUpperCase());
    const friendly = FRIENDLY_CATEGORY[cat.toUpperCase()];
    if (notable && friendly && !out.includes(friendly)) out.push(friendly);
  }
  return out;
}

/** Teacher-mode (verified-adult) provider-safety block copy — honest + actionable. */
export function adultSafetyBlockMessage(safetyInfo?: string): string {
  const cats = blockedCategoryNames(safetyInfo);
  const flagged = cats.length ? ` It flagged **${cats.join(" / ")}**.` : "";
  return (
    `That build was stopped by the AI's content-safety filter.${flagged} ` +
    "Teacher mode already gives faith topics extra latitude, so this went past even that higher bar. " +
    "Try describing the tense parts at a higher level — summarize the conflict or harsh words instead of quoting them directly — and send it again. " +
    "A small wording change usually clears a borderline flag. ✨"
  );
}

// Auto-split success (owner ask 2026-07-23): the full ask was too big to finish
// in one go, so instead of a dead-end we BUILT A WORKING STARTER VERSION with a
// small set and offer to add the rest — which lands as a reliable edit/patch
// turn on the game that now exists. Actionable, not a refusal.
export const BUILD_STARTER_SPLIT =
  "That one was a bit big to build all at once, so I made a **working starter version** to get you playing right away! 🎮 It has just a few to begin with — want them all? Say **\"add the rest\"** and I'll add the full list to this game.";
