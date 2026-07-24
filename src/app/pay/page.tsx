import type { Metadata } from "next";
import { PayAnyAmount } from "@/components/PayAnyAmount.container";

// games-lab.ariantra.com is the canonical host (2026-07-17).
const PAGE_URL = "https://games-lab.ariantra.com/pay";
const SOCIAL_IMAGE = "https://ariantra.com/ariantra-site.png";
const TITLE = "Make a payment — Ariantra";
const DESCRIPTION = "Pay any amount securely on Ariantra.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: PAGE_URL },
  // A payment form is not a shareable/indexable page — keep it out of search.
  robots: { index: false, follow: false },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: PAGE_URL,
    type: "website",
    images: [{ url: SOCIAL_IMAGE, width: 1440, height: 900, alt: "Ariantra" }],
  },
  twitter: { card: "summary_large_image", images: [SOCIAL_IMAGE] },
};

export default function PayPage() {
  return <PayAnyAmount />;
}
