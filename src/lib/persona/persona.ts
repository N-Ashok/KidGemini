// Persona registry (PRD-BIBLE-TEACHER §6). A persona is a SERVER-AUTHORITATIVE
// switch over the child-safe default. It bundles the three things that differ
// between the default child experience and the Sunday-school-teacher authoring
// experience:
//   1. which base system prompt gemini.ts uses (keyed by `id`, so the prompt
//      text can stay in gemini.ts and this module stays free of that cycle),
//   2. the Gemini built-in safety thresholds for the turn,
//   3. the input-rule mode (child vs adult) the /api/chat route applies.
//
// The default persona is the SINGLE SOURCE OF TRUTH for the kids' safety
// posture — gemini.ts's GEN_CONFIG reads PERSONAS.default.safetySettings, so
// there is exactly one place a threshold is set.
//
// resolvePersona is the trust boundary. It FAILS CLOSED to `default` unless the
// session is a verified adult AND the adult persona was explicitly requested —
// a client can never reach the relaxed authoring posture by sending a flag.

import "server-only";
import { HarmBlockThreshold, HarmCategory } from "@google/genai";

export type PersonaId = "default" | "bible-teacher";

/** A Gemini safety threshold entry (category → block threshold), typed with the
 *  SDK enums so it drops straight into generateContent's config.safetySettings. */
export interface SafetySetting {
  category: HarmCategory;
  threshold: HarmBlockThreshold;
}

export interface PersonaConfig {
  id: PersonaId;
  /** Only honored for a VERIFIED-ADULT session (resolvePersona enforces it). */
  requiresAdult: boolean;
  /** Which deterministic input-rule posture /api/chat applies for this persona.
   *  'child' = full child rules (profanity/self-harm/PII soft-blocks + parent
   *  alerts). 'adult' = the teacher is an adult author of their own typing;
   *  hard safety still applies, but child-specific alerting/PII soft-blocks do
   *  not (see PRD §4 — OUTPUT games always stay kid-safe regardless). */
  inputRuleMode: "child" | "adult";
  /** Gemini built-in safetySettings for this persona's generation turns. */
  safetySettings: SafetySetting[];
}

// Child default — the strictest posture. HATE_SPEECH is back at LOW: the
// 2026-07-22 LOW→MEDIUM relaxation (a blocked Sunday-school Bible game) is now
// carried by the bible-teacher persona instead, so the child default no longer
// pays for it. DANGEROUS_CONTENT stays MEDIUM (arcade game-genre allowance).
const CHILD_SAFETY: SafetySetting[] = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
];

// Bible-teacher authoring — same posture as the child default EXCEPT
// HATE_SPEECH relaxed LOW→MEDIUM. Religion is a protected attribute, so benign
// faith content (David & Goliath, the Exodus) trips a LOW hate-speech flag; the
// author is a verified adult and the OUTPUT game is still played by children
// under all the other guards. SEXUALLY_EXPLICIT + HARASSMENT stay strictest.
const BIBLE_TEACHER_SAFETY: SafetySetting[] = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
];

export const PERSONAS: Record<PersonaId, PersonaConfig> = {
  default: {
    id: "default",
    requiresAdult: false,
    inputRuleMode: "child",
    safetySettings: CHILD_SAFETY,
  },
  "bible-teacher": {
    id: "bible-teacher",
    requiresAdult: true,
    inputRuleMode: "adult",
    safetySettings: BIBLE_TEACHER_SAFETY,
  },
};

/** Minimal session shape resolvePersona needs — just the verified adult claim.
 *  Anything richer (email/name) is irrelevant to the persona decision. */
export interface PersonaSession {
  adult?: boolean;
}

/**
 * FAIL-CLOSED persona resolution. Returns the requested persona ONLY when it
 * exists, does not require adulthood OR the session is a verified adult.
 * Everything else — guest, child, missing claim, unknown persona string,
 * adult session with no persona requested — collapses to the child `default`.
 */
export function resolvePersona(
  requested: PersonaId | string | undefined | null,
  session: PersonaSession | null | undefined,
): PersonaConfig {
  const candidate = requested ? PERSONAS[requested as PersonaId] : undefined;
  if (!candidate) return PERSONAS.default;
  if (candidate.requiresAdult && session?.adult !== true) return PERSONAS.default;
  return candidate;
}
