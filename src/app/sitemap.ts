import type { MetadataRoute } from "next";
import { INDEXABLE_PATHS, isProductionDeployment } from "@/lib/security/indexing";
import { siteOrigin } from "@/lib/account/accountMail";

// The fixed public pages, on the site's own address (NEXT_PUBLIC_SITE_URL).
// Empty on every Preview and local build, which robots.txt closes anyway.
// Creator pages (/c/<slug>) are reached by the links creators share.
export default function sitemap(): MetadataRoute.Sitemap {
  const origin = siteOrigin();
  if (!origin || !isProductionDeployment(process.env.VERCEL_ENV)) return [];
  return INDEXABLE_PATHS.filter((path) => !path.endsWith("/") || path === "/").map((path) => ({
    url: `${origin}${path === "/" ? "" : path}`,
    changeFrequency: path === "/" ? "weekly" : "monthly",
    priority: path === "/" ? 1 : 0.3,
  }));
}
