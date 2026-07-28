// Pre-approved replies a helper can send a stuck child
// (docs/PRD-COMMUNITY-HELP.md §3.8 constraint 1: canned-first).
//
// Why a committed file rather than free typing: an adult writing arbitrary text
// to a child is exactly the shape the safety posture exists to contain. A reply
// carrying a `cannedId` came from this list, was reviewed once, here, in a code
// review — free text is the marked exception in the admin UI.
//
// House style, pinned by help-canned.test.ts:
//   · no response-time promises ("soon" is a promise one admin can't keep)
//   · never asks the child for anything personal
//   · always ends in something they can DO — usually a sentence to ask Ari,
//     because the fix a kid can trigger themselves is the one that teaches them

import type { HelpReasonCode } from "@/types/help.types";

export interface CannedReply {
  /** Stable id stored on help_replies.cannedId — proves the reply came from
   *  this reviewed list. Format: `<reasonCode>.<slug>`. */
  id: string;
  reasonCode: HelpReasonCode;
  /** Operator-facing label in the queue picker — not shown to the child. */
  label: string;
  /** Kid-facing text, in a helper's voice (never Ari's, never a kid's). */
  body: string;
}

export const CANNED_REPLIES: readonly CannedReply[] = [
  {
    id: "wont_move.tap_controls",
    reasonCode: "wont_move",
    label: "Keyboard-only controls — needs tap/touch",
    body: "I had a look! Your game only listens to the arrow keys, so nothing happens on a touch screen. Ask me: \"make it move when I tap the screen\" and it'll work on a tablet or phone too. 🎮",
  },
  {
    id: "wont_move.no_start",
    reasonCode: "wont_move",
    label: "Needs a start/go step first",
    body: "Good news — your game works, it just waits for a start! Try tapping the middle of the game first, or ask me: \"add a big START button\". 🟢",
  },
  {
    id: "blank.reload",
    reasonCode: "blank",
    label: "Blank screen — one piece failed to load",
    body: "One piece of your game didn't load, so the screen stayed empty. Ask me: \"build it again without the picture\" and it should show up. 🖼️",
  },
  {
    id: "blank.dark_scene",
    reasonCode: "blank",
    label: "3D scene with no light",
    body: "Your world is there — there's just no light in it yet, so everything looks black! Ask me: \"add bright light to the scene\". 💡",
  },
  {
    id: "looks_wrong.too_big",
    reasonCode: "looks_wrong",
    label: "Layout/sizing off screen",
    body: "Part of your game is drawn outside the window, which is why it looks squished. Ask me: \"make everything fit on the screen\" and I'll resize it. 📐",
  },
  {
    id: "looks_wrong.colors",
    reasonCode: "looks_wrong",
    label: "Colours/art not as expected",
    body: "The shapes are right but the colours aren't what you pictured. Tell me exactly what you want, like: \"make the hero red and the sky purple\". 🎨",
  },
  {
    id: "no_sound.needs_tap",
    reasonCode: "no_sound",
    label: "Browser blocks audio before a tap",
    body: "Your sounds are in there! Browsers stay silent until you tap the game once — give it a tap, and check the volume isn't muted. 🔊",
  },
  {
    id: "no_sound.none_added",
    reasonCode: "no_sound",
    label: "No audio in the game yet",
    body: "This game doesn't have any sounds yet. Ask me: \"add a jump sound and win music\" and I'll put them in. 🎵",
  },
  {
    id: "dont_know.next_step",
    reasonCode: "dont_know",
    label: "Doesn't know what to ask next",
    body: "You're not stuck — you just need an idea! Try one of these: \"add a way to win\", \"put a boss at the end\", or \"make it harder every level\". Tap 📚 Stuck? for more. ✨",
  },
  {
    id: "dont_know.describe_game",
    reasonCode: "dont_know",
    label: "Encourage describing the game they want",
    body: "Tell me your game like you'd tell a friend: who is in it, what they're trying to do, and what gets in their way. That's all I need to build it. 🌟",
  },
  {
    id: "other.looked_and_fixed",
    reasonCode: "other",
    label: "Generic — looked at it, here's the ask to try",
    body: "Thanks for telling me what happened — I've read it and had a look at your game. Ask Ari for the change you described and it should behave now. 👍",
  },
  {
    id: "other.need_more",
    reasonCode: "other",
    label: "Generic — needs the kid to show what happens",
    body: "I want to fix this properly, so tell me one more thing: what were you doing right before it went wrong? Then ask Ari to try that part again. 🔍",
  },
] as const;

export function cannedById(id: string): CannedReply | null {
  return CANNED_REPLIES.find((r) => r.id === id) ?? null;
}

export function cannedFor(reasonCode: HelpReasonCode): CannedReply[] {
  return CANNED_REPLIES.filter((r) => r.reasonCode === reasonCode);
}
