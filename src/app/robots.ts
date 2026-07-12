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
    sitemap: "https://kidgemini.ariantra.com/sitemap.xml",
  };
}
