import type { Metadata } from "next";
import "./globals.css";
import { ArNav } from "@/components/ArNav";
import { ScreenTimeHeartbeat } from "@/components/ScreenTimeHeartbeat";
import { MIXPANEL_SNIPPET } from "@/lib/mixpanel-snippet";

// Ariantra brand kit (tokens + shared header CSS). Served from OUR public/ —
// a local copy so the header never depends on another origin being up. The copy
// is refreshed from the platform repo by `npm run sync:brand` (deploy runs it).
const BRAND_CSS_URL =
  process.env.NEXT_PUBLIC_ARIANTRA_BRAND_URL ?? "/brand/ariantra-brand.v1.css";

// Shared with the platform's root layout fallback (Ariantra-Platform's
// src/app/layout.tsx) — no dedicated Ari social-card asset exists yet. Kept
// in sync by hand (separate repo, no shared module) — 2026-07-18 OG audit.
const SOCIAL_IMAGE = "https://ariantra.com/ariantra-site.png";
const TITLE = "Ari — a friendly, safe AI buddy";
const DESCRIPTION = "A kids-safe AI chat with voice, games, and parent controls.";

export const metadata: Metadata = {
  metadataBase: new URL("https://games-lab.ariantra.com"),
  title: TITLE,
  description: DESCRIPTION,
  // Ariantra brand mark — local copy refreshed by `npm run sync:brand`. PNG
  // fallback first since Google Search indexes PNG/ICO more reliably than SVG.
  icons: {
    icon: [
      { url: "/brand/ariantra-favicon.png", type: "image/png", sizes: "192x192" },
      { url: "/brand/ariantra-favicon.svg", type: "image/svg+xml" },
    ],
    apple: "/brand/apple-touch-icon.png",
  },
  // Fallback for every page that doesn't set its own openGraph/twitter —
  // 2026-07-18 OG audit: previously absent entirely.
  openGraph: {
    siteName: "Ari",
    type: "website",
    images: [{ url: SOCIAL_IMAGE, width: 1440, height: 900, alt: "Ari — a friendly, safe AI buddy for kids" }],
  },
  twitter: {
    card: "summary_large_image",
    images: [SOCIAL_IMAGE],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@500;700&family=Nunito:wght@400;600;700&display=swap"
          rel="stylesheet"
        />
        {/* Inter (Ariantra header) + brand kit CSS — required by <ArNav/>. */}
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
        <link rel="stylesheet" href={BRAND_CSS_URL} />
        {/* Mixpanel analytics — privacy-hardened for a kids' product: recordings
            mask ALL text (chat included), no input/text capture, no IP stored,
            iframes (game artifacts) blocked. See lib/mixpanel-snippet.ts. */}
        <script dangerouslySetInnerHTML={{ __html: MIXPANEL_SNIPPET }} />
      </head>
      <body>
        <ScreenTimeHeartbeat />
        <ArNav />
        {/* NO footer here: the chat (/) is a full-height APP screen, and a
            footer below it is a scroll trap — the message list swallows the
            upward scroll, so kids couldn't get back (BUG-FIX-LOG 2026-07-10).
            Grown-up pages (/parent, /admin, /upgrade) render the footer via
            their own layouts; chat carries Terms/Privacy in the composer. */}
        <div className="ar-app-main">{children}</div>
      </body>
    </html>
  );
}
