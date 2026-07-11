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
