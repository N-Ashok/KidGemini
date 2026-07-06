import type { Metadata } from "next";
import "./globals.css";
import { ArNav } from "@/components/ArNav";
import { ArFooter } from "@/components/ArFooter";
import { MIXPANEL_SNIPPET } from "@/lib/mixpanel-snippet";

// Ariantra brand kit (tokens + shared header CSS). Served from OUR public/ —
// a local copy so the header never depends on another origin being up. The copy
// is refreshed from the platform repo by `npm run sync:brand` (deploy runs it).
const BRAND_CSS_URL =
  process.env.NEXT_PUBLIC_ARIANTRA_BRAND_URL ?? "/brand/ariantra-brand.v1.css";

export const metadata: Metadata = {
  title: "KidGemini — a friendly, safe AI buddy",
  description: "A kids-safe AI chat with voice, games, and parent controls.",
  // Ariantra brand mark — local copy refreshed by `npm run sync:brand`.
  icons: { icon: "/brand/ariantra-favicon.svg" },
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
        <ArNav />
          {/* Footer sits INSIDE the scroll area, below the app screen — full-
              height screens (chat) fill the viewport; scrolling reveals it. */}
        <div className="ar-app-main">
          {children}
          <ArFooter />
        </div>
      </body>
    </html>
  );
}
