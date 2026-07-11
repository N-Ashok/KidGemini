// Parent PIN core — PURE (no db, no Next): scrypt hashing, constant-time
// verify, D6 format rules, and the escalating lockout policy. Routes wire
// this to the ParentAuthStore. PRD-PARENT-AUTH-ALERT-SCOPING §8/§9.
//
// scrypt over argon2id (owner decision): Node built-in, no native module,
// and bounded memory on the shared 1 GB box (MEMORY_BUDGET.md).

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { ParentAuthRecord, VerifyPinResult } from "@/types/parent-auth.types";

export const MAX_PIN_ATTEMPTS = 5;
export const LOCKOUT_MS = 15 * 60_000;
export const LOCKOUT_ESCALATED_MS = 60 * 60_000;
export const ESCALATION_WINDOW_MS = 24 * 60 * 60_000;

/** Obvious sequences a kid tries first (D6 deny-list). */
const TRIVIAL_PINS = new Set(["1234", "4321", "2580", "0852"]);

const SCRYPT_KEYLEN = 32;
// N=2^14, r=8, p=1 — interactive-grade cost, ~16 MB peak, fine on the 1 GB box.
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 };

export function isValidPinFormat(pin: string): boolean {
  if (!/^[0-9]{4}$/.test(pin)) return false;
  if (TRIVIAL_PINS.has(pin)) return false;
  if (/^(\d)\1{3}$/.test(pin)) return false; // 0000, 1111, …
  return true;
}

/** "salt:hash" hex; fresh salt per call. */
export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pin, salt, SCRYPT_KEYLEN, SCRYPT_OPTS);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

function pinMatches(pin: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(pin, Buffer.from(saltHex, "hex"), expected.length, SCRYPT_OPTS);
  return timingSafeEqual(actual, expected);
}

export interface VerifyAttemptOutcome {
  result: VerifyPinResult;
  /** Throttling fields the caller must persist (unchanged on "not-set"). */
  update: Pick<ParentAuthRecord, "attempts" | "lockedUntil" | "lastLockoutAt">;
}

/**
 * One verification attempt against the stored record. Pure: the caller
 * persists `update` (except for not-set) and maps `result` to HTTP.
 */
export function verifyPinAttempt(
  record: ParentAuthRecord | null,
  pin: string,
  now: number,
): VerifyAttemptOutcome {
  if (!record) {
    return {
      result: { ok: false, reason: "not-set" },
      update: { attempts: 0, lockedUntil: null, lastLockoutAt: null },
    };
  }

  const carry = {
    attempts: record.attempts,
    lockedUntil: record.lockedUntil,
    lastLockoutAt: record.lastLockoutAt,
  };

  // Locked: refuse EVERYTHING, including the correct PIN (§12) — otherwise
  // the lock is just a hint to keep guessing.
  if (record.lockedUntil !== null && now < record.lockedUntil) {
    return { result: { ok: false, reason: "locked", unlockAt: record.lockedUntil }, update: carry };
  }

  if (pinMatches(pin, record.pinHash)) {
    return { result: { ok: true }, update: { attempts: 0, lockedUntil: null, lastLockoutAt: record.lastLockoutAt } };
  }

  const attempts = record.attempts + 1;
  if (attempts >= MAX_PIN_ATTEMPTS) {
    // Second lockout inside the window escalates — 10,000 combinations (D6)
    // are only survivable if repeat offenders slow down hard.
    const escalated =
      record.lastLockoutAt !== null && now - record.lastLockoutAt < ESCALATION_WINDOW_MS;
    const unlockAt = now + (escalated ? LOCKOUT_ESCALATED_MS : LOCKOUT_MS);
    return {
      result: { ok: false, reason: "locked", unlockAt },
      update: { attempts: 0, lockedUntil: unlockAt, lastLockoutAt: now },
    };
  }

  return {
    result: { ok: false, reason: "wrong-pin", attemptsLeft: MAX_PIN_ATTEMPTS - attempts },
    update: { attempts, lockedUntil: null, lastLockoutAt: record.lastLockoutAt },
  };
}
