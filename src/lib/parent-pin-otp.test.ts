// Parent-PIN reset OTP (BUG-FIX-LOG 2026-07-27): 6-digit code, scrypt hash,
// resend cooldown + daily cap, 5-attempt verify budget. AUTH CODE — fail closed.
import { describe, it, expect } from "vitest";
import {
  generateOtpCode,
  hashOtpCode,
  canRequestOtp,
  nextOtpRecord,
  verifyOtpAttempt,
  OTP_LENGTH,
  OTP_TTL_MS,
  MAX_OTP_ATTEMPTS,
  RESEND_COOLDOWN_MS,
  MAX_SENDS_PER_WINDOW,
  SEND_WINDOW_MS,
} from "./parent-pin-otp";
import type { ParentPinOtpRecord } from "@/types/parent-auth.types";

const NOW = 1_700_000_000_000;

function record(over: Partial<ParentPinOtpRecord> = {}): ParentPinOtpRecord {
  return {
    accountId: "user:parent@example.com",
    codeHash: hashOtpCode("482913"),
    expiresAt: NOW + OTP_TTL_MS,
    attempts: 0,
    sentAt: NOW - RESEND_COOLDOWN_MS - 1,
    sendCount: 1,
    windowStart: NOW,
    ...over,
  };
}

describe("generateOtpCode", () => {
  it("always produces a zero-padded 6-digit string", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateOtpCode();
      expect(code).toHaveLength(OTP_LENGTH);
      expect(code).toMatch(/^\d{6}$/);
    }
  });
});

describe("hashOtpCode / verifyOtpAttempt matching", () => {
  it("the correct code verifies, a wrong one doesn't", () => {
    const r = record({ codeHash: hashOtpCode("013579") });
    expect(verifyOtpAttempt(r, "013579", NOW).result).toEqual({ ok: true });
    expect(verifyOtpAttempt(r, "013578", NOW).result.ok).toBe(false);
  });

  it("never stores the plaintext code in the hash", () => {
    expect(hashOtpCode("482913")).not.toContain("482913");
  });
});

describe("canRequestOtp", () => {
  it("no existing record → always allowed", () => {
    expect(canRequestOtp(null, NOW)).toEqual({ ok: true });
  });

  it("within the cooldown window → refused with retryAt", () => {
    const r = record({ sentAt: NOW - 1000 });
    const out = canRequestOtp(r, NOW);
    expect(out).toEqual({ ok: false, reason: "cooldown", retryAt: r.sentAt + RESEND_COOLDOWN_MS });
  });

  it("past cooldown but under the daily cap → allowed", () => {
    const r = record({ sentAt: NOW - RESEND_COOLDOWN_MS - 1, sendCount: MAX_SENDS_PER_WINDOW - 1, windowStart: NOW });
    expect(canRequestOtp(r, NOW)).toEqual({ ok: true });
  });

  it("at the daily cap within the window → refused with retryAt at window end", () => {
    const r = record({ sentAt: NOW - RESEND_COOLDOWN_MS - 1, sendCount: MAX_SENDS_PER_WINDOW, windowStart: NOW });
    const out = canRequestOtp(r, NOW);
    expect(out).toEqual({ ok: false, reason: "daily-limit", retryAt: NOW + SEND_WINDOW_MS });
  });

  it("daily cap resets once the window has fully elapsed", () => {
    const r = record({
      sentAt: NOW - RESEND_COOLDOWN_MS - 1,
      sendCount: MAX_SENDS_PER_WINDOW,
      windowStart: NOW - SEND_WINDOW_MS - 1,
    });
    expect(canRequestOtp(r, NOW)).toEqual({ ok: true });
  });
});

describe("nextOtpRecord", () => {
  it("first send: sendCount=1, fresh window", () => {
    const r = nextOtpRecord("user:parent@example.com", "111111", null, NOW);
    expect(r.sendCount).toBe(1);
    expect(r.windowStart).toBe(NOW);
    expect(r.attempts).toBe(0);
    expect(r.expiresAt).toBe(NOW + OTP_TTL_MS);
  });

  it("resend within the window increments sendCount, keeps windowStart", () => {
    const existing = record({ sendCount: 2, windowStart: NOW - 1000 });
    const r = nextOtpRecord(existing.accountId, "222222", existing, NOW);
    expect(r.sendCount).toBe(3);
    expect(r.windowStart).toBe(existing.windowStart);
  });

  it("resend after the window elapsed resets the count and window", () => {
    const existing = record({ sendCount: 5, windowStart: NOW - SEND_WINDOW_MS - 1 });
    const r = nextOtpRecord(existing.accountId, "333333", existing, NOW);
    expect(r.sendCount).toBe(1);
    expect(r.windowStart).toBe(NOW);
  });

  it("a fresh send always resets attempts to 0, even mid-verify of the old code", () => {
    const existing = record({ attempts: 3 });
    const r = nextOtpRecord(existing.accountId, "444444", existing, NOW);
    expect(r.attempts).toBe(0);
  });
});

describe("verifyOtpAttempt", () => {
  it("no record → not-requested, no write needed", () => {
    const out = verifyOtpAttempt(null, "123456", NOW);
    expect(out).toEqual({ result: { ok: false, reason: "not-requested" }, updatedAttempts: null });
  });

  it("expired → expired, no write needed", () => {
    const r = record({ expiresAt: NOW - 1 });
    const out = verifyOtpAttempt(r, "482913", NOW);
    expect(out).toEqual({ result: { ok: false, reason: "expired" }, updatedAttempts: null });
  });

  it("already at the attempt cap → too-many-attempts without re-checking the code", () => {
    const r = record({ attempts: MAX_OTP_ATTEMPTS });
    const out = verifyOtpAttempt(r, "482913", NOW); // correct code, still refused
    expect(out).toEqual({ result: { ok: false, reason: "too-many-attempts" }, updatedAttempts: null });
  });

  it("correct code → ok, caller should clear (not increment attempts)", () => {
    const r = record();
    const out = verifyOtpAttempt(r, "482913", NOW);
    expect(out).toEqual({ result: { ok: true }, updatedAttempts: null });
  });

  it("wrong code → wrong-code with attemptsLeft, caller persists the bumped count", () => {
    const r = record({ attempts: 1 });
    const out = verifyOtpAttempt(r, "000000", NOW);
    expect(out).toEqual({
      result: { ok: false, reason: "wrong-code", attemptsLeft: MAX_OTP_ATTEMPTS - 2 },
      updatedAttempts: 2,
    });
  });

  it("the wrong attempt that spends the last try → too-many-attempts, caller still persists it", () => {
    const r = record({ attempts: MAX_OTP_ATTEMPTS - 1 });
    const out = verifyOtpAttempt(r, "000000", NOW);
    expect(out).toEqual({
      result: { ok: false, reason: "too-many-attempts" },
      updatedAttempts: MAX_OTP_ATTEMPTS,
    });
  });
});
