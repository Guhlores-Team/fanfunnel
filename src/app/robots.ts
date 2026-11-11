import type { MetadataRoute } from "next";
import { robotsPolicy } from "@/lib/security/indexing";
import { siteOrigin } from "@/lib/account/accountMail";

// SUP-9. Built once per deployment: Vercel sets VERCEL_ENV at build time, so a
// Preview build disallows everything and only Production lists its pages and
// points crawlers at the sitemap on the site's own address.
export default function robots(): MetadataRoute.Robots {
  return robotsPolicy(process.env.VERCEL_ENV, siteOrigin());
}
