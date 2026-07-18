// Kid-facing home — the Gemini-style chat experience (sidebar + chat + artifacts).

import type { Metadata } from "next";
import { ChatPanelContainer } from "@/components/ChatPanel.container";

// games-lab.ariantra.com is the canonical host (2026-07-17, later same day)
// — supersedes ari.ariantra.com.
const PAGE_URL = "https://games-lab.ariantra.com/";
// Same asset as the root layout's fallback (src/app/layout.tsx) — set
// explicitly, not inherited: Next.js doesn't reliably deep-merge a parent
// layout's openGraph.images into a page that sets its own openGraph object
// (2026-07-18 OG audit).
const SOCIAL_IMAGE = "https://ariantra.com/ariantra-site.png";

export const metadata: Metadata = {
  title: "Ari — a friendly, safe AI buddy",
  description: "Chat, build games, and play with Ari — a kids-safe AI buddy with voice and parent controls.",
  alternates: { canonical: PAGE_URL },
  openGraph: {
    title: "Ari — a friendly, safe AI buddy",
    description: "Chat, build games, and play with Ari — a kids-safe AI buddy with voice and parent controls.",
    url: PAGE_URL,
    type: "website",
    images: [{ url: SOCIAL_IMAGE, width: 1440, height: 900, alt: "Ari — a friendly, safe AI buddy for kids" }],
  },
  twitter: {
    card: "summary_large_image",
    images: [SOCIAL_IMAGE],
  },
};

export default function HomePage() {
  return <ChatPanelContainer />;
}
