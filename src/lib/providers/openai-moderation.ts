// OpenAI moderation pass — the middle safety layer for OpenAI-served turns
// (owner decision 2026-07-20, option A).
//
// WHY THIS EXISTS: Ari's posture (CLAUDE.md §3) is input rules →
// provider-enforced thresholds → child-safety prompt. On Gemini the middle
// layer is `safetySettings` on the generation call itself. OpenAI has no such
// per-request knob, so without this an OpenAI turn would run one layer short.
// With it, `gpt-*` entries in MODEL_CATALOG can honestly flip from
// `prompt-only` to `provider-enforced`.
//
// It implements SafetyClassifier, so it is Liskov-substitutable with
// RulesClassifier / FlashLiteClassifier and speaks the same SafetyVerdict
// vocabulary — no parallel safety concept to keep in sync.

import "server-only";
import type { SafetyCategory, SafetyClassifier, SafetyVerdict } from "@/types/safety.types";
import { ALWAYS_HARD_BLOCK } from "../safety.config";

/** The omni-moderation response fields we read. */
interface ModerationResponse {
  results: Array<{ flagged?: boolean; category_scores?: Record<string, number> }>;
}

type Moderate = (text: string) => Promise<ModerationResponse>;

/**
 * OpenAI category → Ari category, with the score above which we act.
 *
 * The thresholds are the whole design. safety.config.ts states plainly that
 * "cartoon video-game action (space shooters, sword adventures…) is NOT
 * violence" and "fictional weapons inside a game a child is making are NOT
 * dangerous acts", and gemini.ts sets DANGEROUS_CONTENT to
 * BLOCK_MEDIUM_AND_ABOVE (not LOW) for exactly that reason — LOW blocked
 * ordinary game-genre requests. OpenAI's endpoint scores raw text with no idea
 * a child is building an arcade game, so violence/illicit get a deliberately
 * HIGH bar while sexual/self-harm/hate stay strict.
 *
 * ⚠ CALIBRATION: these numbers mirror the Gemini posture by intent, not by
 * measurement — they have not been run against real turns. Before OpenAI
 * serves kid-facing traffic, replay a sample (game-build requests especially)
 * and tune. Tracked with the prompt-portability eval in PRD-MODEL-FALLBACK §7.
 */
const RULES: Array<{ key: string; category: SafetyCategory; threshold: number }> = [
  // Zero tolerance — any signal at all acts.
  { key: "sexual/minors", category: "sexual", threshold: 0 },
  // Strict: mirrors BLOCK_LOW_AND_ABOVE on Gemini.
  { key: "sexual", category: "sexual", threshold: 0.2 },
  { key: "self-harm", category: "self_harm", threshold: 0.2 },
  { key: "self-harm/intent", category: "self_harm", threshold: 0.2 },
  { key: "self-harm/instructions", category: "self_harm", threshold: 0.2 },
  { key: "hate", category: "hate", threshold: 0.5 },
  { key: "hate/threatening", category: "hate", threshold: 0.4 },
  { key: "harassment", category: "hate", threshold: 0.5 },
  { key: "harassment/threatening", category: "hate", threshold: 0.4 },
  // Permissive: the arcade carve-out. A shooting game is not a safety event.
  { key: "violence", category: "violence", threshold: 0.85 },
  { key: "violence/graphic", category: "violence", threshold: 0.9 },
  { key: "illicit", category: "dangerous_acts", threshold: 0.85 },
  { key: "illicit/violent", category: "dangerous_acts", threshold: 0.85 },
];

/** Any error, missing key, or unreadable response → block. Mirrors
 *  FlashLiteClassifier: a safety check that didn't happen is not an allow. */
const BLOCKED = (reason: string): SafetyVerdict => ({
  action: "hard_block",
  category: null,
  severity: "high",
  reason,
});

export class OpenAIModerationClassifier implements SafetyClassifier {
  private readonly moderate?: Moderate;
  private readonly env: Record<string, string | undefined>;
  private readonly model: string;

  /** `moderate` is injectable so the policy above can be pinned by tests
   *  without a network call — the safety rules are the part that must never
   *  drift, and they should be testable offline. */
  constructor(deps: { moderate?: Moderate; env?: Record<string, string | undefined> } = {}) {
    this.moderate = deps.moderate;
    this.env = deps.env ?? process.env;
    this.model = this.env.OPENAI_MODERATION_MODEL ?? "omni-moderation-latest";
  }

  private async call(text: string): Promise<ModerationResponse> {
    if (this.moderate) return this.moderate(text);
    const apiKey = this.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
    // Imported lazily: the Gemini-only path must not pay for this module.
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey });
    return (await client.moderations.create({ model: this.model, input: text })) as unknown as ModerationResponse;
  }

  async classify(input: { text: string; origin: "child" | "model" }): Promise<SafetyVerdict> {
    let res: ModerationResponse;
    try {
      res = await this.call(input.text);
    } catch (err) {
      console.error(`[safety:openai] moderation error: ${(err as Error).message}`);
      return BLOCKED("Safety check failed; blocked as a precaution.");
    }

    const result = res?.results?.[0];
    if (!result || !result.category_scores) {
      // An empty/!unparseable body is NOT "nothing was flagged".
      console.error("[safety:openai] moderation returned no usable result");
      return BLOCKED("Safety check returned no result; blocked as a precaution.");
    }

    // Highest-scoring rule that clears its own bar wins, so the verdict names
    // the most confident violation rather than whichever was listed first.
    const hits = RULES
      .map((r) => ({ ...r, score: result.category_scores![r.key] ?? 0 }))
      .filter((r) => r.score > r.threshold)
      .sort((a, b) => b.score - a.score);

    if (hits.length === 0) {
      return { action: "allow", category: null, severity: "low", reason: "No moderation category exceeded its threshold." };
    }

    const top = hits[0]!;
    // Same hardening rule the Gemini classifier applies, from the same config —
    // these categories block regardless of score or origin.
    const always = ALWAYS_HARD_BLOCK.includes(top.category);
    const action = always || top.score >= 0.8 ? "hard_block" : "soft_block";
    const severity = always || top.score >= 0.8 ? "high" : "medium";
    console.log(`[safety:openai] origin=${input.origin} category=${top.category} score=${top.score.toFixed(2)} action=${action}`);
    return {
      action,
      category: top.category,
      severity,
      reason: `OpenAI moderation flagged ${top.key} (${top.score.toFixed(2)}).`,
    };
  }
}
