import type { MetadataRoute } from "next";
import { robotsPolicy } from "@/lib/security/indexing";

// SUP-9. Built once per deployment: Vercel sets VERCEL_ENV at build time, so a
// Preview build disallows everything and only Production lists its pages.
export default function robots(): MetadataRoute.Robots {
  return robotsPolicy(process.env.VERCEL_ENV);
}
