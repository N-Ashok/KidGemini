// Tunable safety policy. Add categories or change strictness here (Open/Closed) —
// call sites don't change. The parent dashboard can override `strictness` at runtime.

import type { SafetyCategory } from "@/types/safety.types";

export type Strictness = "relaxed" | "standard" | "strict";

export const DEFAULT_STRICTNESS: Strictness = "strict";

/** Human-readable description fed to the classifier prompt for each category. */
export const CATEGORY_GUIDE: Record<SafetyCategory, string> = {
  sexual: "sexual content, nudity, or romantic/sexual themes",
  violence:
    "graphic or realistic violence, gore, or threats of harm against people — cartoon video-game action (space shooters, sword adventures, tank games with bloodless 'pop/vanish' enemies) is NOT violence",
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
