// Per-family parent PIN (PRD-PARENT-AUTH-ALERT-SCOPING, platform docs).
// The PIN is a hashed local re-auth gate keyed by the SSO userId — Ariantra
// SSO remains the primary identity. Types first; routes depend on the
// interfaces, never on better-sqlite3 directly.

export interface ParentAuthRecord {
  /** SSO userId ("user:<email>") — the family account key. */
  accountId: string;
  /** scrypt hash, "salt:hash" hex. Never a plaintext PIN. */
  pinHash: string;
  setAt: number;
  /** Consecutive failed verifies since the last success. */
  attempts: number;
  /** ms epoch until which verification is refused; null = not locked. */
  lockedUntil: number | null;
  /** When the last lockout started — drives the 24h escalation window. */
  lastLockoutAt: number | null;
}

export interface ParentAuthStore {
  get(accountId: string): ParentAuthRecord | null;
  /** Insert or replace the whole record (set/reset PIN). */
  put(record: ParentAuthRecord): void;
  /** Update only the throttling fields after a verify attempt. */
  recordAttempt(
    accountId: string,
    fields: Pick<ParentAuthRecord, "attempts" | "lockedUntil" | "lastLockoutAt">,
  ): void;
}

/** Outcome of a PIN verification attempt (never carries the PIN itself). */
export type VerifyPinResult =
  | { ok: true }
  | { ok: false; reason: "wrong-pin"; attemptsLeft: number }
  | { ok: false; reason: "locked"; unlockAt: number }
  | { ok: false; reason: "not-set" };

/**
 * One-time email code that gates PIN set/reset (BUG-FIX-LOG 2026-07-27,
 * replaces the old fresh-SSO-session gate — see parent-pin-otp.ts). Proves
 * the caller can read the family account's email, which a kid sharing the
 * parent's already-logged-in device cannot fake.
 */
export interface ParentPinOtpRecord {
  accountId: string;
  /** scrypt hash, "salt:hash" hex. Never the plaintext code. */
  codeHash: string;
  expiresAt: number;
  /** Consecutive wrong-code verifies since this code was issued. */
  attempts: number;
  sentAt: number;
  /** Codes sent within the current `windowStart` rolling window (abuse cap). */
  sendCount: number;
  windowStart: number;
}

export interface ParentPinOtpStore {
  get(accountId: string): ParentPinOtpRecord | null;
  /** Insert or replace the whole record (a fresh send). */
  put(record: ParentPinOtpRecord): void;
  /** Update only the attempt counter after a verify attempt. */
  recordAttempt(accountId: string, attempts: number): void;
  /** Single-use: clear after a successful verify (or a spent code). */
  clear(accountId: string): void;
}

export type RequestOtpResult =
  | { ok: true }
  | { ok: false; reason: "cooldown"; retryAt: number }
  | { ok: false; reason: "daily-limit"; retryAt: number };

/** Outcome of a PIN-reset OTP verification attempt (never carries the code). */
export type VerifyOtpResult =
  | { ok: true }
  | { ok: false; reason: "not-requested" }
  | { ok: false; reason: "expired" }
  | { ok: false; reason: "too-many-attempts" }
  | { ok: false; reason: "wrong-code"; attemptsLeft: number };
