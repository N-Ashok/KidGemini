import type { Metadata } from "next";
import { UpgradePlans } from "@/components/UpgradePlans.container";

// games-lab.ariantra.com is the canonical host (2026-07-17, later same day)
// — supersedes ari.ariantra.com.
const PAGE_URL = "https://games-lab.ariantra.com/upgrade";
// Same asset as the root layout's fallback — set explicitly, not inherited
// (2026-07-18 OG audit; see src/app/page.tsx for why).
const SOCIAL_IMAGE = "https://ariantra.com/ariantra-site.png";
const TITLE = "Buy Sparks — Ariantra";
const DESCRIPTION = "Top up Sparks to keep building with Ari — one-time packs, pay only for what each ask uses, never expires.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: PAGE_URL },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: PAGE_URL,
    type: "website",
    images: [{ url: SOCIAL_IMAGE, width: 1440, height: 900, alt: "Ari — a friendly, safe AI buddy for kids" }],
  },
  twitter: {
    card: "summary_large_image",
    images: [SOCIAL_IMAGE],
  },
};

export default function UpgradePage() {
  return <UpgradePlans />;
}
