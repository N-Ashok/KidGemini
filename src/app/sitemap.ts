// SEO plumbing (repo rule 6). Public, content-bearing pages only — the chat
// home, the asset gallery, and the pricing page.
import type { MetadataRoute } from "next";

const BASE = "https://kidgemini.ariantra.com";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${BASE}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${BASE}/assets`, changeFrequency: "weekly", priority: 0.8 },
    { url: `${BASE}/upgrade`, changeFrequency: "monthly", priority: 0.5 },
  ];
}
