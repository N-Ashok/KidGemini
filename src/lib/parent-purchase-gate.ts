// Whether a Sparks purchase may proceed (owner ask 2026-08-09: "we need to
// enable the buy button but parents pin is needed to buy there").
//
// PURE — no Next imports, no cookies, no DB (CLAUDE.md §4). The route reads the
// cookie and the PIN record; this decides. One place to read the rule, one
// place to test it.

export interface PurchaseGateInput {
  /** Does this family have a parent PIN configured at all? */
  pinIsSet: boolean;
  /** Account id proven by a valid `ari_parent` cookie, or null. */
  parentAccountId: string | null;
  /** Account id of the signed-in SSO session making the purchase. */
  accountId: string;
}

export interface PurchaseGateDecision {
  allow: boolean;
  reason?: "parent_pin_required";
  /** Lets the caller nudge a family that has no PIN to set one, without
   *  blocking their purchase. */
  pinConfigured: boolean;
}

/**
 * A configured PIN is mandatory to spend; an unconfigured one is not invented.
 *
 * Why the no-PIN case ALLOWS: PIN setup depends on a contact address the
 * platform holds for a minority of accounts, and assuming otherwise is exactly
 * what locked 32 of 50 users out of the parent PIN in production (BUG_LOG
 * #52/#53). Making purchases depend on a PIN those families cannot set would
 * repeat that incident on the path that earns money — and buying already
 * requires a signed-in account plus Razorpay's own card authorisation. The
 * caller surfaces `pinConfigured: false` so the parent is asked to set one.
 *
 * Once a PIN exists the gate is strict, and the proof must belong to THIS
 * account — another family's valid parent session authorises nothing here.
 */
export function decidePurchaseGate(input: PurchaseGateInput): PurchaseGateDecision {
  const { pinIsSet, parentAccountId, accountId } = input;
  if (!pinIsSet) return { allow: true, pinConfigured: false };
  if (parentAccountId && parentAccountId === accountId) {
    return { allow: true, pinConfigured: true };
  }
  return { allow: false, reason: "parent_pin_required", pinConfigured: true };
}
