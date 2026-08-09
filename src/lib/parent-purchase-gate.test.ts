import { describe, it, expect } from "vitest";
import { decidePurchaseGate } from "./parent-purchase-gate";

// Owner ask 2026-08-09: "we need to enable the buy button but parents pin is
// needed to buy there." Money leaving a saved card is a parent action, so a
// correct PIN must stand between the kid and Razorpay.
//
// The one judgement call, stated out loud: what happens to a family with NO
// PIN set. Requiring one would fail closed, but PIN setup depends on an email
// we hold for a minority of accounts (BUG_LOG #52/#53 — 32 of 50 users were
// locked out of the parent PIN by exactly that assumption). Blocking purchases
// on a PIN those families cannot set would repeat that incident on the revenue
// path, so a family with no PIN keeps today's working behaviour and is nudged
// to set one. Buying still requires a signed-in account and Razorpay's own
// card authorisation.
describe("parent PIN gate on a Sparks purchase", () => {
  it("blocks when a PIN is set and no parent session is present", () => {
    const d = decidePurchaseGate({ pinIsSet: true, parentAccountId: null, accountId: "user:a" });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe("parent_pin_required");
  });

  it("allows when a PIN is set and the parent session matches the account", () => {
    const d = decidePurchaseGate({ pinIsSet: true, parentAccountId: "user:a", accountId: "user:a" });
    expect(d.allow).toBe(true);
  });

  it("blocks a parent session belonging to a DIFFERENT account", () => {
    // Fail closed on a tenancy boundary: someone else's valid PIN proof must
    // never authorise a purchase on this family's card.
    const d = decidePurchaseGate({ pinIsSet: true, parentAccountId: "user:b", accountId: "user:a" });
    expect(d.allow).toBe(false);
    expect(d.reason).toBe("parent_pin_required");
  });

  it("allows a family that has no PIN set, and says a PIN is not configured", () => {
    const d = decidePurchaseGate({ pinIsSet: false, parentAccountId: null, accountId: "user:a" });
    expect(d.allow).toBe(true);
    expect(d.pinConfigured).toBe(false);
  });

  it("still allows when no PIN is set even if a stale parent session is around", () => {
    const d = decidePurchaseGate({ pinIsSet: false, parentAccountId: "user:a", accountId: "user:a" });
    expect(d.allow).toBe(true);
  });
});
