// Tunable safety policy. Add categories or change strictness here (Open/Closed) —
// call sites don't change. The parent dashboard can override `strictness` at runtime.

import type { SafetyCategory } from "@/types/safety.types";

export type Strictness = "relaxed" | "standard" | "strict";

export const DEFAULT_STRICTNESS: Strictness = "strict";

/** Human-readable description fed to the classifier prompt for each category. */
export const CATEGORY_GUIDE: Record<SafetyCategory, string> = {
  sexual: "sexual content, nudity, or romantic/sexual themes",
  violence:
    // Widened 2026-08-16 (owner): "kids want bullets and guns and it's part of
    // games they play". The old wording carved out only CARTOON action, so a
    // child asking for a realistic shooter could be classified as violence and
    // blocked BEFORE the model ever saw it — which would have made the prompt
    // change below useless. Game-making is the carve-out now; gore and
    // real-world harm are still violence.
    "gore, or threats of harm against REAL people — a child asking to MAKE OR PLAY a video game with guns, bullets, shooting, tanks, soldiers or sword fighting is NOT violence, however realistic they want it to look",
  self_harm: "self-harm, suicide, eating disorders",
  hate: "hate, harassment, slurs, or demeaning groups",
  dangerous_acts:
    "instructions for REAL-WORLD dangerous/illegal acts (building actual weapons, drugs, etc.) — fictional weapons inside a game a child is making/playing are NOT dangerous acts",
  personal_info: "the child sharing personal info (full name, address, school, phone)",
  stranger_contact: "arranging to meet or contact strangers, grooming patterns",
  profanity: "profanity or crude language",
};

/** Categories that ALWAYS hard-block + raise a high-severity parent alert. */
export const ALWAYS_HARD_BLOCK: SafetyCategory[] = [
  "sexual",
  "self_harm",
  "stranger_contact",
];
