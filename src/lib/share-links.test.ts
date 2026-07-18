import { describe, it, expect } from "vitest";
import { whatsappShareUrl } from "./share-links";

// Share dead-end (BUG-FIX-LOG 2026-07-18): the WhatsApp button must be a real
// anchor to wa.me. The old whatsapp:// deep link + delayed window.open
// fallback died silently on machines without the app (popup blocker eats a
// window.open outside the click's user-activation window), while the UI
// flipped to "Thanks for sharing" anyway.
describe("whatsappShareUrl", () => {
  it("targets wa.me — the reliable web↔app hand-off — never the whatsapp:// scheme", () => {
    const url = whatsappShareUrl("hi");
    expect(url).toBe("https://wa.me/?text=hi");
    expect(url.startsWith("https://")).toBe(true);
  });

  it("encodes spaces, newlines, and embedded URLs safely", () => {
    expect(whatsappShareUrl("Play this\nhttps://maze.ariantra.com/")).toBe(
      "https://wa.me/?text=Play%20this%0Ahttps%3A%2F%2Fmaze.ariantra.com%2F",
    );
  });

  it("keeps & and # from breaking the query string", () => {
    expect(whatsappShareUrl("cats & dogs #1")).toBe("https://wa.me/?text=cats%20%26%20dogs%20%231");
  });
});
