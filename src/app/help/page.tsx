// /help — the 📚 Help Gallery (docs/PRD-COMMUNITY-HELP.md Phase 2).
//
// Server shell so the page can own its metadata; the interactive grid is the
// client component beside it. Content is committed in lib/help-cards.ts, so
// this page is fully SSR-readable — the cards and their prompts are in the HTML
// with no JS needed to read them.

import type { Metadata } from "next";
import { HelpGallery } from "./HelpGallery";

export const metadata: Metadata = {
  title: "Stuck? Ideas to try · Ari",
  description:
    "Simple things to ask Ari when your game isn't working or you don't know what to try next — tap one and Ari builds it.",
  // Kid-app surface, not a marketing page: no canonical/OG work needed beyond
  // the root layout's defaults, but it stays crawlable (nothing private here).
};

export default function HelpPage() {
  return <HelpGallery />;
}
