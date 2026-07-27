// Parent-PIN reset OTP — PURE (no db, no Next): 6-digit code generation,
// scrypt hashing, constant-time verify, resend cooldown + daily send cap, and
// a 5-attempt verify budget. BUG-FIX-LOG 2026-07-27.
//
// Replaces the old "fresh SSO session (iat ≤ 5 min)" gate on PIN set/reset:
// that gate re-used the platform login, but a live Google browser session
// (or a saved password) clears it with no secret only the parent has — on a
// shared family device, a kid locked out of guessing the PIN could just
// reset it. Proving the caller can read the mail sent to the account's own
// address is a real second factor a kid sharing the device doesn't have.

import { randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import type { ParentPinOtpRecord, RequestOtpResult, VerifyOtpResult } from "@/types/parent-auth.types";

export const OTP_LENGTH = 6;
export const OTP_TTL_MS = 10 * 60_000;
export const MAX_OTP_ATTEMPTS = 5;
export const RESEND_COOLDOWN_MS = 60_000;
export const MAX_SENDS_PER_WINDOW = 5;
export const SEND_WINDOW_MS = 24 * 60 * 60_000;

const SCRYPT_KEYLEN = 32;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 };

/** Unbiased 6-digit code, zero-padded ("004821"). */
export function generateOtpCode(): string {
  return randomInt(0, 10 ** OTP_LENGTH).toString().padStart(OTP_LENGTH, "0");
}

/** "salt:hash" hex; fresh salt per call — same shape as parent-pin.ts's hashPin. */
export function hashOtpCode(code: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(code, salt, SCRYPT_KEYLEN, SCRYPT_OPTS);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

function otpMatches(code: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(code, Buffer.from(saltHex, "hex"), expected.length, SCRYPT_OPTS);
  return timingSafeEqual(actual, expected);
}

/** Gate a fresh send: cooldown since the last code, and a rolling daily cap
 *  (mail cost / abuse — a locked-out kid mashing "resend" must not spam the
 *  parent's inbox). */
export function canRequestOtp(record: ParentPinOtpRecord | null, now: number): RequestOtpResult {
  if (!record) return { ok: true };
  if (now - record.sentAt < RESEND_COOLDOWN_MS) {
    return { ok: false, reason: "cooldown", retryAt: record.sentAt + RESEND_COOLDOWN_MS };
  }
  const windowExpired = now - record.windowStart >= SEND_WINDOW_MS;
  if (!windowExpired && record.sendCount >= MAX_SENDS_PER_WINDOW) {
    return { ok: false, reason: "daily-limit", retryAt: record.windowStart + SEND_WINDOW_MS };
  }
  return { ok: true };
}

/** The record to persist for a freshly (re)issued code — call only after
 *  `canRequestOtp` allows it. */
export function nextOtpRecord(
  accountId: string,
  code: string,
  existing: ParentPinOtpRecord | null,
  now: number,
): ParentPinOtpRecord {
  const windowExpired = !existing || now - existing.windowStart >= SEND_WINDOW_MS;
  return {
    accountId,
    codeHash: hashOtpCode(code),
    expiresAt: now + OTP_TTL_MS,
    attempts: 0,
    sentAt: now,
    sendCount: windowExpired ? 1 : existing.sendCount + 1,
    windowStart: windowExpired ? now : existing.windowStart,
  };
}

export interface VerifyOtpOutcome {
  result: VerifyOtpResult;
  /** Attempts to persist via `recordAttempt`; null means no write is needed
   *  (nothing requested/already expired) or the record should be cleared
   *  (success, or the attempt that spends the last try) — callers branch on
   *  `result` to tell those apart, this is purely "what to write". */
  updatedAttempts: number | null;
}

/** One verification attempt. Pure: the caller persists `updatedAttempts`
 *  (via `recordAttempt`) on a wrong-code result, and clears the record via
 *  `clear` on success (single-use) or once attempts are spent. */
export function verifyOtpAttempt(record: ParentPinOtpRecord | null, code: string, now: number): VerifyOtpOutcome {
  if (!record) return { result: { ok: false, reason: "not-requested" }, updatedAttempts: null };
  if (now > record.expiresAt) return { result: { ok: false, reason: "expired" }, updatedAttempts: null };
  if (record.attempts >= MAX_OTP_ATTEMPTS) {
    return { result: { ok: false, reason: "too-many-attempts" }, updatedAttempts: null };
  }
  if (otpMatches(code, record.codeHash)) {
    return { result: { ok: true }, updatedAttempts: null };
  }
  const attempts = record.attempts + 1;
  if (attempts >= MAX_OTP_ATTEMPTS) {
    return { result: { ok: false, reason: "too-many-attempts" }, updatedAttempts: attempts };
  }
  return {
    result: { ok: false, reason: "wrong-code", attemptsLeft: MAX_OTP_ATTEMPTS - attempts },
    updatedAttempts: attempts,
  };
}
