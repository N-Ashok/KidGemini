"use client";
// Ariantra shared header — same markup/classes as the platform's NavBar/Logo
// (Ariantra-Platform src/lib/ui). Styling comes from the brand kit CSS linked in
// the root layout, so this header is pixel-identical across www / catalog /
// studio / Ari (renamed from "kidgemini" 2026-07-17). Header-only rebrand:
// the kid-styled interior is untouched.
//
// Canonical menu (2026-08-06: landing's parent-language labels win, owner
// decision — mirrors the platform's nav-links.ts):
//   Skills · Games · Games-Lab(active) · How it works · Videos · Studio · [Log in] · [Book CTA]
// "Games-Lab" (not "Ari") is the label here deliberately — "Ari" is the
// in-app AI-buddy PERSONA (chat identity, unchanged everywhere else — logo,
// docs); "Games-Lab" is the product/nav/domain name for the destination
// itself. Self-referencing (href="/", marked `on`/active) same as the
// original "Ari" tab was, since Ari's own canonical host is now
// games-lab.ariantra.com (2026-07-17, later same day, owner direction —
// supersedes ari.ariantra.com the way ari.ariantra.com itself superseded
// kidgemini.ariantra.com): visiting "/" on THIS domain already IS "Games-Lab".
// Matches the already-regenerated static header partials
// (public/brand/ariantra-header.html, deploy/hostinger/landing-snippet.html)
// and the platform's nav-links.ts (CROSS.ari's value updated there). This
// file is a hand-kept duplicate (TECH_DEBT #17/#2) — no build step syncs
// it, so a future label/href change here needs the same by-hand update.
// "Studio" is a plain menu item that OPENS the Studio app (no returnTo — the
// user stays in Studio after signing in there). The subtle "Log in" enters
// Ari's session via the shared SSO (signIn() → studio /login?returnTo=
// here) and hides once authenticated.
// Mobile (2026-07-08): primary nav moves to an app-like bottom tab bar
// (.ar-tabbar, same CSS as the platform's NavBar) — Chat · Arcade · Parent —
// instead of the hamburger. Desktop keeps the full top menu unchanged.

// Environment-aware cross-links: `next dev` keeps navigation on localhost
// (platform app on :3000 by convention) so local dev never ejects to prod.
// NODE_ENV is inlined per build — server & client render identical hrefs.
import { useState } from "react";
import { usePathname } from "next/navigation";
import { signIn, useSession } from "@/lib/useAriantraSession";
import { useSparksBalance } from "@/lib/useSparksBalance";
import { formatSparks } from "@/lib/sparks-display";
import { isTabActive, mobileTabs } from "@/lib/nav-tabs";

const DEV = process.env.NODE_ENV === "development";
const WWW_URL = DEV ? "http://localhost:3000" : "https://ariantra.com";
const GAMES_URL = DEV ? "http://localhost:3000/catalog" : "https://games.ariantra.com";
// Bible listing is its OWN platform route, NOT a child of the catalog path —
// in dev the catalog is /catalog while Bible games are /bible-games, so this
// cannot be derived from GAMES_URL. Matches PublishToArcade's "view it" link.
const BIBLE_GAMES_URL = DEV ? "http://localhost:3000/bible-games" : "https://games.ariantra.com/bible-games";
const STUDIO_URL = DEV ? "http://localhost:3000/studio" : "https://studio.ariantra.com";
// 2026-07-11 CTA revamp: the loud CTA creates a game. On Ari itself that
// means starting a new chat — "/" — not a cross-site hop (guarded by ar-cta.test.ts).
const CREATE_URL = "/";

// The nav is ALWAYS VISIBLE, on every route including the chat page.
//
// A chat-page-only hover-to-reveal auto-hide shipped 2026-07-28 to buy vertical
// space while building; the owner reversed it a day later ("it is an useless
// thing let the nav menu be fixed"), and they're right: a bar you have to go
// looking for costs a deliberate mouse trip to the top of the screen every time,
// while the space it saved was one 56px strip. Hidden-until-hover navigation
// also has no touch equivalent, so the desktop and mobile behaviours diverged
// for no reason. The reveal-modifier and hover-strip rules were deleted from the
// brand kit generator too (Ariantra-Platform scripts/build-brand-css.mjs), so a
// class name re-added here would style nothing. Both halves are pinned by
// ar-nav-fixed.test.ts, which greps this file — hence no class names in prose.

export function ArNav() {
  const { status } = useSession();
  // Live balance (docs/2026-08-27_PRD_SparksPage.md §2b; owner 2026-08-27:
  // everyone sees it). null = loading → "⚡ …", never a blank.
  const balance = useSparksBalance(status === "authenticated");
  const sparksLabel = balance == null ? "⚡ …" : `⚡ ${formatSparks(balance)}`;
  const pathname = usePathname();
  const isChatRoute = pathname === "/";

  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);

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
            {/* Landing anchor — always prod, like #how/#videos below. */}
            <a href="https://ariantra.com/#skills" className="ar-link">What they learn</a>
            <a href={GAMES_URL} className="ar-link">Games by kids</a>
            <a href="/" className="ar-link on">Games-Lab</a>
            {/* Ari-local (not in the canonical platform menu): the kid's
                Sparks wallet only exists on this app, and only means
                something signed-in (PRD-SPARKS Phase 4). */}
            {status === "authenticated" && (
              <a href="/wallet" className="ar-link" title="Your Sparks">{sparksLabel}</a>
            )}
            <a href={`${WWW_URL}/#how`} className="ar-link">How it works</a>
            <a href={`${WWW_URL}/pricing.html`} className="ar-link">Pricing</a>
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
            <a href={CREATE_URL} className="ar-cta">
              Start their first game — free
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
            {/* Mobile-only (CSS-gated, .ar-nav-menu-btn) menu icon — chat page
                only. Opens the sheet below, which lists the same links
                .ar-nav-links has, since mobile hides that menu entirely. */}
            {isChatRoute && (
              <button
                type="button"
                aria-label="Open menu"
                aria-haspopup="dialog"
                aria-expanded={mobileSheetOpen}
                className="ar-nav-menu-btn"
                onClick={() => setMobileSheetOpen(true)}
              >
                <span aria-hidden="true">☰</span>
              </button>
            )}
          </div>
        </div>
      </header>
      {/* Tabs are per-surface (src/lib/nav-tabs.ts): the Bible-teacher surface
          sends Arcade to the Bible listing and drops the kid-only Parent tab. */}
      <nav className="ar-tabbar" aria-label="Primary">
        {mobileTabs(pathname ?? "/", GAMES_URL, BIBLE_GAMES_URL).map((tab) => (
          <a
            key={tab.id}
            href={tab.href}
            className={`ar-tab ${isTabActive(tab, pathname ?? "/") ? "on" : ""}`}
          >
            <span className="ar-tab-icon" aria-hidden="true">{tab.icon}</span>
            {/* Mobile Sparks tab shows the live balance once known (PRD_SparksPage §2b). */}
            {tab.id === "sparks" && balance != null ? formatSparks(balance) : tab.label}
          </a>
        ))}
      </nav>
      {isChatRoute && mobileSheetOpen && (
        <>
          <button
            aria-label="Close menu"
            className="ar-nav-sheet-overlay"
            onClick={() => setMobileSheetOpen(false)}
          />
          <div className="ar-nav-sheet" role="dialog" aria-modal="true" aria-label="Menu">
            <div className="ar-nav-sheet-header">
              <span className="ar-nav-sheet-title">Menu</span>
              <button
                type="button"
                aria-label="Close menu"
                className="ar-nav-sheet-close"
                onClick={() => setMobileSheetOpen(false)}
              >
                ✕
              </button>
            </div>
            {/* Same link set as .ar-nav-links (desktop) — mobile never shows
                that menu, so this is the only place these links exist there. */}
            <nav className="ar-nav-sheet-links" aria-label="Ariantra">
              <a href="https://ariantra.com/#skills" className="ar-link" onClick={() => setMobileSheetOpen(false)}>What they learn</a>
              <a href={GAMES_URL} className="ar-link" onClick={() => setMobileSheetOpen(false)}>Games by kids</a>
              <a href="/" className="ar-link on" onClick={() => setMobileSheetOpen(false)}>Games-Lab</a>
              {status === "authenticated" && (
                <a href="/wallet" className="ar-link" onClick={() => setMobileSheetOpen(false)} title="Your Sparks">{sparksLabel}</a>
              )}
              <a href={`${WWW_URL}/#how`} className="ar-link" onClick={() => setMobileSheetOpen(false)}>How it works</a>
              <a href={`${WWW_URL}/pricing.html`} className="ar-link" onClick={() => setMobileSheetOpen(false)}>Pricing</a>
              <a href={`${WWW_URL}/#videos`} className="ar-link" onClick={() => setMobileSheetOpen(false)}>Videos</a>
              <a href={STUDIO_URL} className="ar-link" onClick={() => setMobileSheetOpen(false)}>Studio</a>
              {status !== "authenticated" && (
                <a
                  href="#login"
                  className="ar-link ar-signin"
                  onClick={(e) => { e.preventDefault(); setMobileSheetOpen(false); signIn(); }}
                >
                  Log in
                </a>
              )}
            </nav>
          </div>
        </>
      )}
    </>
  );
}
