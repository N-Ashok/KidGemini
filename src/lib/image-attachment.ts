// Deterministic guards for picture uploads — the input-side safety boundary
// for images (owner decision 2026-07-09: allow-list + size cap here, content
// judged in-generation by Gemini's built-in strict safety; no pre-check call).
// Fail-closed: anything malformed, off-list, or oversized is rejected.
// Pure logic, no React/Next.

import type { ImageAttachment } from "@/types/chat.types";

/** svg (scriptable) and gif deliberately excluded; the client downscales to jpeg anyway. */
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/** ~1.1 MB decoded — far above the client's ~1024px jpeg output, well below body-size abuse. */
export const MAX_IMAGE_BASE64_CHARS = 1_500_000;

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

type Verdict = { ok: true; image: ImageAttachment } | { ok: false; reason: string };

export function validateImageAttachment(input: unknown): Verdict {
  if (typeof input !== "object" || input === null) return { ok: false, reason: "not an object" };
  const { mimeType, data } = input as { mimeType?: unknown; data?: unknown };
  if (typeof mimeType !== "string" || !ALLOWED_MIME_TYPES.has(mimeType)) {
    return { ok: false, reason: "mime type not allowed" };
  }
  if (typeof data !== "string" || data.length === 0) return { ok: false, reason: "empty payload" };
  if (data.length > MAX_IMAGE_BASE64_CHARS) return { ok: false, reason: "too large" };
  if (data.length % 4 !== 0 || !BASE64_RE.test(data)) return { ok: false, reason: "not base64" };
  return { ok: true, image: { mimeType: mimeType as ImageAttachment["mimeType"], data } };
}
