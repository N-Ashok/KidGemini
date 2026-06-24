// The safety gate. Single responsibility: classify text as allow / soft / hard block.
// Uses the fast Flash-Lite model. Fails CLOSED (see CLAUDE.md § 3). Server-only.

import "server-only";
import { GoogleGenAI, Type } from "@google/genai";
import type {
  SafetyCategory,
  SafetyClassifier,
  SafetyVerdict,
} from "@/types/safety.types";
import { ALWAYS_HARD_BLOCK, CATEGORY_GUIDE } from "./safety.config";
import { withRetry } from "./retry";

export class SafetyGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafetyGateError";
  }
}

const CATEGORY_LIST = Object.entries(CATEGORY_GUIDE)
  .map(([key, desc]) => `- ${key}: ${desc}`)
  .join("\n");

function buildPrompt(text: string, origin: "child" | "model"): string {
  const subject =
    origin === "child"
      ? "a message a CHILD typed/spoke to an AI"
      : "a DRAFT answer an AI wants to show a CHILD";
  return `You are a strict child-safety classifier. Evaluate ${subject}.
Categories of concern:
${CATEGORY_LIST}

Return the single highest-risk category (or null if none), a severity
(low|medium|high), and the action: "allow" if clearly fine for a young child,
"soft_block" if mildly inappropriate, "hard_block" if unsafe.
When uncertain, prefer the safer (more blocking) option.

TEXT:
"""${text}"""`;
}

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    category: { type: Type.STRING, nullable: true },
    severity: { type: Type.STRING, enum: ["low", "medium", "high"] },
    action: { type: Type.STRING, enum: ["allow", "soft_block", "hard_block"] },
    reason: { type: Type.STRING },
  },
  required: ["severity", "action", "reason"],
};

/** Flash-Lite-backed classifier. Substitutable for any SafetyClassifier. */
export class FlashLiteClassifier implements SafetyClassifier {
  private model = process.env.GEMINI_SAFETY_MODEL ?? "gemini-2.5-flash-lite";

  async classify(input: {
    text: string;
    origin: "child" | "model";
  }): Promise<SafetyVerdict> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new SafetyGateError("GEMINI_API_KEY is not set");
    const ai = new GoogleGenAI({ apiKey });

    try {
      const res = await withRetry(
        () => ai.models.generateContent({
          model: this.model,
          contents: buildPrompt(input.text, input.origin),
          config: {
            responseMimeType: "application/json",
            responseSchema: RESPONSE_SCHEMA,
            temperature: 0,
          },
        }),
        { label: "safety.classify" },
      );
      const parsed = JSON.parse(res.text ?? "{}") as Partial<SafetyVerdict>;
      return this.harden(parsed);
    } catch (err) {
      // FAIL CLOSED: any error → block + surface to parent.
      console.error(`[safety] classifier error: ${(err as Error).message}`);
      return {
        action: "hard_block",
        category: null,
        severity: "high",
        reason: "Safety check failed; blocked as a precaution.",
      };
    }
  }

  /** Enforce non-negotiable rules regardless of what the model returned. */
  private harden(v: Partial<SafetyVerdict>): SafetyVerdict {
    const category = (v.category as SafetyCategory | null) ?? null;
    let action = v.action ?? "hard_block";
    let severity = v.severity ?? "high";

    if (category && ALWAYS_HARD_BLOCK.includes(category)) {
      action = "hard_block";
      severity = "high";
    }
    console.log(`[safety] category=${category} severity=${severity} action=${action}`);
    return { action, category, severity, reason: v.reason ?? "n/a" };
  }
}
