// The Help Gallery's cards (docs/PRD-COMMUNITY-HELP.md Phase 2).
//
// Team-authored and committed here, which is what makes this phase cheap: no
// user-generated content ⇒ no runtime moderation, no reporting flow, no queue.
// A typed TS module rather than the PRD's proposed src/content/help/*.json —
// this repo has no src/content/ and no JSON-schema CI step, and `tsc` plus
// help-cards.test.ts give the same guarantee with nothing new to maintain
// (same shape as game-suggestions.ts / tweak-suggestions.ts).
//
// The ONE thing every card must do is end in a tap: `prompt` is sent verbatim
// through the normal handleSend → /api/chat path, so a pre-reader never has to
// compose the sentence — they only have to recognise the picture. Nothing here
// bypasses the safety path; nothing is generated server-side.
//
// Authoring loop: Phase 1's reasonCode histogram (/admin/help) says which card
// to write next, so this list grows from real stuck moments rather than guesses.

import type { HelpReasonCode } from "@/types/help.types";

export interface HelpCard {
  id: string;
  /** Which stuck moment this answers — the 🆘 sheet's 🤷 chip links here. */
  reasonCode: HelpReasonCode;
  emoji: string;
  title: string;
  /** Sent to Ari verbatim on ✨ Ask Ari this. */
  prompt: string;
  /** Read aloud on 🔊 — the title plus enough context to be useful alone. */
  readAloud: string;
}

export const HELP_CARDS: readonly HelpCard[] = [
  {
    id: "tap-controls",
    reasonCode: "wont_move",
    emoji: "📱",
    title: "Make it move when I tap",
    prompt: "make my game move when I tap the screen, not just with the arrow keys",
    readAloud: "Make it move when I tap. This adds touch controls so your game works on a tablet or phone.",
  },
  {
    id: "start-button",
    reasonCode: "wont_move",
    emoji: "🟢",
    title: "Add a big START button",
    prompt: "add a big START button to my game that begins the game when I press it",
    readAloud: "Add a big start button, so it's clear how to begin your game.",
  },
  {
    id: "way-to-win",
    reasonCode: "dont_know",
    emoji: "🏁",
    title: "Add a way to win",
    prompt: "add a way to win my game, with a You Win screen when I get there",
    readAloud: "Add a way to win, with a you-win screen at the end.",
  },
  {
    id: "add-boss",
    reasonCode: "dont_know",
    emoji: "🐉",
    title: "Put a boss at the end",
    prompt: "add a boss at the end of my game that is harder than everything else",
    readAloud: "Put a boss at the end, tougher than the rest of the game.",
  },
  {
    id: "new-world",
    reasonCode: "dont_know",
    emoji: "🌊",
    title: "Change where my game happens",
    prompt: "change my game so the whole thing happens underwater",
    readAloud: "Change where your game happens — like moving the whole thing underwater.",
  },
  {
    id: "add-sounds",
    reasonCode: "no_sound",
    emoji: "🔊",
    title: "Add sounds to my game",
    prompt: "add sound effects to my game: a jump sound, a point sound, and win music",
    readAloud: "Add sounds — a jump sound, a point sound, and music when you win.",
  },
  {
    id: "fit-screen",
    reasonCode: "looks_wrong",
    emoji: "📐",
    title: "Make everything fit the screen",
    prompt: "make everything in my game fit on the screen so nothing is cut off",
    readAloud: "Make everything fit the screen, so nothing gets cut off the edge.",
  },
  {
    id: "change-colors",
    reasonCode: "looks_wrong",
    emoji: "🎨",
    title: "Change the colours",
    prompt: "change the colours in my game: make the hero bright red and the background dark purple",
    readAloud: "Change the colours of your hero and the background.",
  },
  {
    id: "add-light",
    reasonCode: "blank",
    emoji: "💡",
    title: "My 3D world is all black",
    prompt: "add bright light to my 3D scene so I can see everything in it",
    readAloud: "My 3D world is all black. This adds light so you can see it.",
  },
  {
    id: "rebuild-simple",
    reasonCode: "blank",
    emoji: "🧱",
    title: "Build it again, simpler",
    prompt: "build my game again but simpler, without any pictures that might not load",
    readAloud: "Build it again, simpler, in case a picture stopped it from loading.",
  },
] as const;

export function helpCardsFor(reasonCode: HelpReasonCode): HelpCard[] {
  return HELP_CARDS.filter((c) => c.reasonCode === reasonCode);
}

export function helpCardById(id: string): HelpCard | null {
  return HELP_CARDS.find((c) => c.id === id) ?? null;
}
