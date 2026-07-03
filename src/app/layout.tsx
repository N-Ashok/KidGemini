import type { Metadata } from "next";
import "./globals.css";
import { AuthProvider } from "@/components/AuthProvider";
import { ArNav } from "@/components/ArNav";

// Ariantra brand kit (tokens + shared header CSS). Served from OUR public/ —
// a local copy so the header never depends on another origin being up. The copy
// is refreshed from the platform repo by `npm run sync:brand` (deploy runs it).
const BRAND_CSS_URL =
  process.env.NEXT_PUBLIC_ARIANTRA_BRAND_URL ?? "/brand/ariantra-brand.v1.css";

export const metadata: Metadata = {
  title: "KidGemini — a friendly, safe AI buddy",
  description: "A kids-safe AI chat with voice, games, and parent controls.",
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
      </head>
      <body>
        <AuthProvider>
          <ArNav />
          <div className="ar-app-main">{children}</div>
        </AuthProvider>
      </body>
    </html>
  );
}
