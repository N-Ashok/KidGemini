// SEO plumbing (repo rule 6): public pages are crawlable; the API and the
// grown-up/admin surfaces are not content.
import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/admin/", "/parent/"],
    },
    // games-lab.ariantra.com is the canonical host (2026-07-17, later same
    // day) — supersedes ari.ariantra.com.
    sitemap: "https://games-lab.ariantra.com/sitemap.xml",
  };
}
