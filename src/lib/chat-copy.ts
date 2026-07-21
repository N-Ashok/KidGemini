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

// A MODEL false-positive — the child's request was fine (input rules allowed it)
// but the provider's own safety layer blocked the generation (finishReason
// SAFETY). Here the topic-change redirect is wrong and confusing: the kid was
// mid-build and did nothing wrong, so we own the hiccup and invite a retry
// instead of telling them to go do "something else" (owner call, 2026-07-21;
// BUG-FIX-LOG: false-positive safety block on a valid game edit).
export const MODEL_GLITCH_RETRY =
  "Oops, that one tangled me up! Say it another way and I'll keep building your game. ✨";
