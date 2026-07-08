"use client";
// Ariantra shared header — same markup/classes as the platform's NavBar/Logo
// (Ariantra-Platform src/lib/ui). Styling comes from the brand kit CSS linked in
// the root layout, so this header is pixel-identical across www / catalog /
// studio / kidgemini. Header-only rebrand: the kid-styled interior is untouched.
//
// Canonical menu (2026-07-03 unification, mirrors the platform's nav-links.ts):
//   Games · KidGemini(active) · How it works · Videos · Studio · [Log in] · [Book CTA]
// "Studio" is a plain menu item that OPENS the Studio app (no returnTo — the
// user stays in Studio after signing in there). The subtle "Log in" enters
// KIDGEMINI's session via the shared SSO (signIn() → studio /login?returnTo=
// here) and hides once authenticated.
// Mobile (2026-07-08): primary nav moves to an app-like bottom tab bar
// (.ar-tabbar, same CSS as the platform's NavBar) — Chat · Arcade · Parent —
// instead of the hamburger. Desktop keeps the full top menu unchanged.

// Environment-aware cross-links: `next dev` keeps navigation on localhost
// (platform app on :3000 by convention) so local dev never ejects to prod.
// NODE_ENV is inlined per build — server & client render identical hrefs.
import { usePathname } from "next/navigation";
import { signIn, useSession } from "@/lib/useAriantraSession";

const DEV = process.env.NODE_ENV === "development";
const WWW_URL = DEV ? "http://localhost:3000" : "https://ariantra.com";
const GAMES_URL = DEV ? "http://localhost:3000/catalog" : "https://games.ariantra.com";
const STUDIO_URL = DEV ? "http://localhost:3000/studio" : "https://studio.ariantra.com";
const BOOK_URL =
  "https://wa.me/918800364622?text=Hi%2C%20I%27d%20like%20to%20book%20a%20free%20first%20session%20for%20my%20kid.";

export function ArNav() {
  const { status } = useSession();
  const pathname = usePathname();
  return (
    <>
      <header className="ar-nav">
        <div className="ar-nav-inner">
          <a href={WWW_URL} aria-label="Ariantra AI Foundry" className="ar-logo">
            <span className="ar-logo-word">Ariantra</span>
            <span className="ar-logo-divider">
              <span className="ar-logo-line" />
              <span className="ar-logo-dot" />
              <span className="ar-logo-line" />
            </span>
            <span className="ar-logo-sub">AI Foundry</span>
          </a>
          <nav className="ar-nav-links">
            <a href={GAMES_URL} className="ar-link">Games</a>
            <a href="/" className="ar-link on">KidGemini</a>
            <a href={`${WWW_URL}/#how`} className="ar-link">How it works</a>
            <a href={`${WWW_URL}/#videos`} className="ar-link">Videos</a>
            <a href={STUDIO_URL} className="ar-link">Studio</a>
            {status !== "authenticated" && (
              <a
                href="#login"
                className="ar-link ar-signin"
                onClick={(e) => { e.preventDefault(); signIn(); }}
              >
                Log in
              </a>
            )}
          </nav>
          <div className="ar-nav-right">
            <a href={BOOK_URL} target="_blank" rel="noopener" className="ar-cta">
              Book a free session
            </a>
            {status !== "authenticated" && (
              <a
                href="#login"
                className="ar-link ar-account-icon"
                aria-label="Log in"
                onClick={(e) => { e.preventDefault(); signIn(); }}
              >
                <span className="ar-signin-icon" aria-hidden="true">👤</span>
                <span className="ar-signin-label">Log in</span>
              </a>
            )}
          </div>
        </div>
      </header>
      <nav className="ar-tabbar" aria-label="Primary">
        <a href="/" className={`ar-tab ${pathname === "/" ? "on" : ""}`}>
          <span className="ar-tab-icon" aria-hidden="true">💬</span>Chat
        </a>
        <a href={GAMES_URL} className="ar-tab">
          <span className="ar-tab-icon" aria-hidden="true">🎮</span>Arcade
        </a>
        <a href="/parent" className={`ar-tab ${pathname === "/parent" ? "on" : ""}`}>
          <span className="ar-tab-icon" aria-hidden="true">👪</span>Parent
        </a>
      </nav>
    </>
  );
}
