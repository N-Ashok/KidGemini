// Parent-alert + persistence types.

import type { AlertSeverity, SafetyAction, SafetyCategory } from "./safety.types";

export interface ParentAlert {
  id: string;
  createdAt: number;
  /** "system" = a policy-derived alert (e.g. screen-time cap crossed) — not
   *  a SafetyVerdict from the classifier, so `category` is always null and
   *  `action` is always "allow" for this origin. */
  origin: "child" | "model" | "system";
  category: SafetyCategory | null;
  severity: AlertSeverity;
  action: SafetyAction;
  /** The text that triggered the flag. Visible to parents only. */
  triggerText: string;
  reason: string;
}

/** Persistence boundary — concrete impl (SQLite) is injected at the edge. */
export interface AlertStore {
  record(alert: Omit<ParentAlert, "id" | "createdAt">): ParentAlert;
  list(limit?: number): ParentAlert[];
}
