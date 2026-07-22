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
