// SUP-9: what search engines may crawl and index. Imports nothing at runtime:
// next.config.ts loads it, like csp.ts.
//
// Only a Production deployment (VERCEL_ENV === "production") is indexable.
// Every Preview, branch alias, local build and CI build is closed to crawlers
// (robots.txt disallows everything and every response carries X-Robots-Tag),
// because Previews run against TEST data and their branch aliases are public.
import type { MetadataRoute } from "next";

export const isProductionDeployment = (vercelEnv: string | undefined) => vercelEnv === "production";

// Public and meant to be found: the marketing pages and creator pages.
export const INDEXABLE_PATHS = ["/", "/c/", "/privacy", "/terms"] as const;

// Fan-facing or signed-in surfaces. /spin carries a secret token; /share,
// /verify and /leaderboard show fan handles and play receipts that are
// shareable by link but should not be listed in search results.
export const PRIVATE_PATHS = [
  "/spin/", "/share/", "/verify/", "/leaderboard/",
  "/api/", "/dashboard", "/admin", "/agency", "/pending", "/mfa", "/auth/",
  "/login", "/forgot-password", "/reset-password",
] as const;

// Link-preview crawlers honor robots.txt too (Twitterbot does): let them fetch
// a share card (/share/<id> and its opengraph-image) so a shared link still
// unfurls. Search engines keep the `*` rule.
export const LINK_PREVIEW_BOTS = [
  "Twitterbot", "facebookexternalhit", "LinkedInBot", "Slackbot-LinkExpanding", "Discordbot", "WhatsApp", "TelegramBot",
] as const;

export function robotsPolicy(vercelEnv: string | undefined): MetadataRoute.Robots {
  if (!isProductionDeployment(vercelEnv)) return { rules: { userAgent: "*", disallow: "/" } };
  return {
    rules: [
      { userAgent: "*", allow: [...INDEXABLE_PATHS], disallow: [...PRIVATE_PATHS] },
      {
        userAgent: [...LINK_PREVIEW_BOTS],
        allow: [...INDEXABLE_PATHS, "/share/"],
        disallow: PRIVATE_PATHS.filter((path) => path !== "/share/"),
      },
    ],
  };
}

// Response headers added on every route of a non-Production deployment.
export function indexingHeaders(vercelEnv: string | undefined): { key: string; value: string }[] {
  return isProductionDeployment(vercelEnv) ? [] : [{ key: "X-Robots-Tag", value: "noindex, nofollow" }];
}
