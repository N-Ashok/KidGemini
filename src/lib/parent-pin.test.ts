// Parent PIN core (PRD-PARENT-AUTH-ALERT-SCOPING §8/§9, D6): scrypt hashing,
// constant-time verify, 4-digit validation with a trivial-sequence deny-list,
// and the 5-attempt / 15-min lockout with 24h escalation to 1 hour.
// AUTH CODE — tests first, fail closed.
import { describe, it, expect } from "vitest";
import {
  hashPin,
  isValidPinFormat,
  verifyPinAttempt,
  MAX_PIN_ATTEMPTS,
  LOCKOUT_MS,
  LOCKOUT_ESCALATED_MS,
  ESCALATION_WINDOW_MS,
} from "./parent-pin";
import type { ParentAuthRecord } from "@/types/parent-auth.types";

const NOW = 1_700_000_000_000;

function record(over: Partial<ParentAuthRecord> = {}): ParentAuthRecord {
  return {
    accountId: "user:parent@example.com",
    pinHash: hashPin("8264"),
    setAt: NOW - 1000,
    attempts: 0,
    lockedUntil: null,
    lastLockoutAt: null,
    ...over,
  };
}

describe("isValidPinFormat (D6: 4 digits, deny trivial)", () => {
  it("accepts a normal 4-digit PIN", () => {
    expect(isValidPinFormat("8264")).toBe(true);
  });

  it("rejects wrong lengths and non-digits", () => {
    for (const bad of ["", "12", "123", "12345", "12a4", "١٢٣٤", "12 4"]) {
      expect(isValidPinFormat(bad)).toBe(false);
    }
  });

  it("rejects the obvious sequences a kid guesses first", () => {
    for (const bad of ["0000", "1111", "9999", "1234", "4321", "2580"]) {
      expect(isValidPinFormat(bad)).toBe(false);
    }
  });
});

describe("hashPin", () => {
  it("never stores the PIN and salts every hash", () => {
    const a = hashPin("8264");
    const b = hashPin("8264");
    expect(a).not.toContain("8264");
    expect(a).not.toBe(b); // fresh salt each time
  });
});

describe("verifyPinAttempt", () => {
  it("correct PIN verifies and resets throttling", () => {
    const r = verifyPinAttempt(record({ attempts: 3 }), "8264", NOW);
    expect(r.result).toEqual({ ok: true });
    expect(r.update.attempts).toBe(0);
    expect(r.update.lockedUntil).toBeNull();
  });

  it("wrong PIN counts down attempts", () => {
    const r = verifyPinAttempt(record(), "1112", NOW);
    expect(r.result).toEqual({ ok: false, reason: "wrong-pin", attemptsLeft: MAX_PIN_ATTEMPTS - 1 });
    expect(r.update.attempts).toBe(1);
  });

  it(`locks for 15 minutes on the ${MAX_PIN_ATTEMPTS}th failure`, () => {
    const r = verifyPinAttempt(record({ attempts: MAX_PIN_ATTEMPTS - 1 }), "1112", NOW);
    expect(r.result).toEqual({ ok: false, reason: "locked", unlockAt: NOW + LOCKOUT_MS });
    expect(r.update.lockedUntil).toBe(NOW + LOCKOUT_MS);
    expect(r.update.lastLockoutAt).toBe(NOW);
  });

  it("a second lockout within 24h escalates to 1 hour (D6: 4 digits need this)", () => {
    const r = verifyPinAttempt(
      record({ attempts: MAX_PIN_ATTEMPTS - 1, lastLockoutAt: NOW - ESCALATION_WINDOW_MS + 60_000 }),
      "1112",
      NOW,
    );
    expect(r.result).toEqual({ ok: false, reason: "locked", unlockAt: NOW + LOCKOUT_ESCALATED_MS });
  });

  it("a lockout older than 24h does NOT escalate", () => {
    const r = verifyPinAttempt(
      record({ attempts: MAX_PIN_ATTEMPTS - 1, lastLockoutAt: NOW - ESCALATION_WINDOW_MS - 60_000 }),
      "1112",
      NOW,
    );
    expect(r.result).toEqual({ ok: false, reason: "locked", unlockAt: NOW + LOCKOUT_MS });
  });

  it("the CORRECT pin still fails while locked (§12)", () => {
    const until = NOW + 10 * 60_000;
    const r = verifyPinAttempt(record({ lockedUntil: until }), "8264", NOW);
    expect(r.result).toEqual({ ok: false, reason: "locked", unlockAt: until });
    expect(r.update.attempts).toBe(0); // locked attempts don't stack further
  });

  it("an expired lock verifies normally again", () => {
    const r = verifyPinAttempt(record({ lockedUntil: NOW - 1, attempts: MAX_PIN_ATTEMPTS }), "8264", NOW);
    expect(r.result).toEqual({ ok: true });
  });

  it("no record → not-set (fail closed, no timing oracle on existence)", () => {
    const r = verifyPinAttempt(null, "8264", NOW);
    expect(r.result).toEqual({ ok: false, reason: "not-set" });
  });
});
