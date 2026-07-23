/**
 * Login-origin resolution (SSO). Regression guard for the 2026-07-23 bug:
 * a locally-served PRODUCTION build (`next start`, NODE_ENV="production") sent
 * sign-in to studio.ariantra.com instead of the LOCAL platform, so the user's
 * localhost draft was lost. The origin MUST come from the live host, not
 * build-time NODE_ENV. Auth code is NEVER untested (CLAUDE.md §7.4).
 */
import { describe, it, expect } from "vitest";
import { resolveLoginUrl, ageUrlFrom } from "./login-url";

describe("resolveLoginUrl", () => {
  it("L.1 localhost → LOCAL platform login, regardless of build mode", () => {
    // The bug: this used to depend on NODE_ENV, so a local prod build failed here.
    expect(resolveLoginUrl("localhost")).toBe("http://localhost:3000/login");
    expect(resolveLoginUrl("127.0.0.1")).toBe("http://localhost:3000/login");
  });

  it("L.2 real hostname → production platform login", () => {
    expect(resolveLoginUrl("games-lab.ariantra.com")).toBe(
      "https://studio.ariantra.com/login",
    );
    expect(resolveLoginUrl("ari.ariantra.com")).toBe(
      "https://studio.ariantra.com/login",
    );
  });

  it("L.3 undefined host (SSR) fails closed to production", () => {
    expect(resolveLoginUrl(undefined)).toBe("https://studio.ariantra.com/login");
  });

  it("L.4 explicit env override always wins (both local and prod hosts)", () => {
    const override = "https://staging.ariantra.com/login";
    expect(resolveLoginUrl("localhost", override)).toBe(override);
    expect(resolveLoginUrl("games-lab.ariantra.com", override)).toBe(override);
  });

  it("L.5 age gate sits beside login on the same host", () => {
    expect(ageUrlFrom("http://localhost:3000/login")).toBe(
      "http://localhost:3000/age",
    );
    expect(ageUrlFrom("https://studio.ariantra.com/login")).toBe(
      "https://studio.ariantra.com/age",
    );
  });
});
