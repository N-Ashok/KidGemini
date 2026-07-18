// Share-channel link builders.
//
// WhatsApp (BUG-FIX-LOG 2026-07-18, replaces the 2026-07-17 whatsapp://
// deep link): the share button must be a real `<a href>` to wa.me, opened by
// the browser itself. The previous approach — navigate to `whatsapp://send`
// and window.open(wa.me) from a 1.2s timer if nothing "took over" — silently
// did NOTHING on machines without the app: the custom-scheme navigation
// no-ops, the click's transient user activation is spent by the time the
// timer fires, so the popup blocker eats the window.open, and the blur from
// Chrome's own protocol dialog could cancel the fallback outright. wa.me
// itself hands off to the installed app (mobile and WhatsApp Desktop) and
// offers WhatsApp Web otherwise — one extra tap when the app exists, zero
// dead ends when it doesn't.
//
// Anchors are never popup-blocked; do NOT "upgrade" this back to a
// programmatic open. No non-BMP emoji in the message text — wa.me's redirect
// to api.whatsapp.com corrupts them (see PublishToArcade share copy).
//
// Kept in sync by hand with Ariantra-Platform's
// src/lib/publish/share-links.ts (+ the inline copy in share-overlay.ts).

export function whatsappShareUrl(text: string): string {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}
