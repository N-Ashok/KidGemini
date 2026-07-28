// One function for "put this in the parent's alerts list".
//
// It exists as its own module for two reasons: the help-reply mirror
// (docs/PRD-COMMUNITY-HELP.md §3.8 constraint 3) is a guarantee worth pinning
// in a test, and mocking a whole db module in a route test would also stub out
// the ticket store the same route needs. This is the seam.

import "server-only";
import { SqliteAlertStore } from "./db";
import type { ParentAlert } from "@/types/alert.types";

const alerts = new SqliteAlertStore();

export function recordParentAlert(alert: Omit<ParentAlert, "id" | "createdAt">): void {
  alerts.record(alert);
}
