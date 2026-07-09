import { describe, it, expect } from "vitest";
import { validateImageAttachment, MAX_IMAGE_BASE64_CHARS } from "./image-attachment";

// Safety boundary for picture uploads (owner decision 2026-07-09: deterministic
// guards + Gemini built-in safety, no separate pre-check call). Fail-closed:
// anything not on the allow-list is rejected.

const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("image-attachment — deterministic input guards (fail-closed)", () => {
  it("accepts a well-formed png/jpeg/webp payload", () => {
    for (const mimeType of ["image/png", "image/jpeg", "image/webp"]) {
      const v = validateImageAttachment({ mimeType, data: PIXEL });
      expect(v.ok).toBe(true);
      if (v.ok) expect(v.image).toEqual({ mimeType, data: PIXEL });
    }
  });

  it("rejects mime types off the allow-list (svg can script, gif unvetted)", () => {
    for (const mimeType of ["image/svg+xml", "image/gif", "text/html", "application/pdf", ""]) {
      expect(validateImageAttachment({ mimeType, data: PIXEL }).ok).toBe(false);
    }
  });

  it("rejects oversized payloads", () => {
    const big = "A".repeat(MAX_IMAGE_BASE64_CHARS + 4);
    expect(validateImageAttachment({ mimeType: "image/jpeg", data: big }).ok).toBe(false);
  });

  it("rejects payloads that are not plausible base64", () => {
    expect(validateImageAttachment({ mimeType: "image/png", data: "<script>alert(1)</script>" }).ok).toBe(false);
    expect(validateImageAttachment({ mimeType: "image/png", data: "" }).ok).toBe(false);
  });

  it("rejects malformed shapes without throwing (fail-closed)", () => {
    for (const bad of [null, undefined, 42, "x", {}, { mimeType: "image/png" }, { data: PIXEL }, { mimeType: 1, data: 2 }]) {
      expect(validateImageAttachment(bad).ok).toBe(false);
    }
  });
});
