// Entitlement predicate (Phase 5, ../Ariantra-Platform/docs/PRD-MULTIPLAYER.md
// Open Decision #1, resolved: platform-side check, Ari stays the source
// of truth). Extracted from api/billing/status/route.ts's inline expression
// so /api/entitlement/check (the new cross-repo endpoint the platform calls)
// shares the exact same rule instead of a second, driftable copy.

import type { PaymentRecord } from "@/types/billing.types";

export function isEntitled(record: PaymentRecord | null, now: number = Date.now()): boolean {
  return !!record && record.status === "paid" && (record.periodEndsAt ?? 0) > now;
}
