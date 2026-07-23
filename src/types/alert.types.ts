// Parent-alert + persistence types.

import type { AlertSeverity, SafetyAction, SafetyCategory } from "./safety.types";

export interface ParentAlert {
  id: string;
  createdAt: number;
  /** The account this alert belongs to (the child's identity at the time —
   *  `user:<email>` for a signed-in family account, `guest:<id>` otherwise).
   *  PRD-PARENT-AUTH-ALERT-SCOPING §8 Phase 2: a parent sees ONLY the alerts
   *  whose accountId matches their verified parent account — never another
   *  family's. Fail closed: an alert with no matching account is shown to no one. */
  accountId: string;
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
  /** ONLY the alerts belonging to `accountId` — a parent never sees another
   *  family's (PRD-PARENT-AUTH-ALERT-SCOPING §8 Phase 2). Fail closed: an alert
   *  with no matching accountId is returned to no one. */
  list(accountId: string, limit?: number): ParentAlert[];
}
