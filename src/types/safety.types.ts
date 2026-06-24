// Shared safety types. API routes depend on these interfaces, not on concrete
// SDK classes (Dependency Inversion — see CLAUDE.md § 4).

export type SafetyCategory =
  | "sexual"
  | "violence"
  | "self_harm"
  | "hate"
  | "dangerous_acts"
  | "personal_info"
  | "stranger_contact"
  | "profanity";

export type SafetyAction = "allow" | "soft_block" | "hard_block";

export type AlertSeverity = "low" | "medium" | "high";

export interface SafetyVerdict {
  action: SafetyAction;
  /** Highest-severity category that triggered, if any. */
  category: SafetyCategory | null;
  severity: AlertSeverity;
  /** Short, machine/parent-readable reason. Never shown to the child. */
  reason: string;
}

/** Anything that can judge text is a SafetyClassifier (Liskov-substitutable). */
export interface SafetyClassifier {
  classify(input: { text: string; origin: "child" | "model" }): Promise<SafetyVerdict>;
}
