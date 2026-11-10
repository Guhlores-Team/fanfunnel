import type { NextConfig } from "next";
import { buildCsp } from "./src/lib/security/csp";
import { indexingHeaders } from "./src/lib/security/indexing";
import { maintenanceRewrites } from "./src/lib/ops/maintenance";
import { assertProductionEnv, isProductionBuild } from "./src/lib/ops/productionEnv";

// OPS3-01: a Production build (Vercel's Production scope, or a self-hosted
// FF_REQUIRE_SUPABASE=1 build) fails here, naming the variable, when a key the
// live site cannot run without is missing or malformed. Previews, local and
// CI builds and `next start` are untouched (src/lib/ops/productionEnv.ts).
if (isProductionBuild()) assertProductionEnv();

// Security response headers applied to every route. Rationale:
// - Referrer-Policy: strict-origin-when-cross-origin — never send the full URL
//   (which for a fan is `/spin/<secret-token>`) to a third party; only the bare
//   origin leaves the site. Stops the spin token leaking via the Referer header.
// - X-Content-Type-Options: nosniff — no MIME sniffing of API/JSON/upload bytes.
// - X-Frame-Options + CSP frame-ancestors — the app is never meant to be framed;
//   blocks clickjacking (e.g. tricking a fan into spinning/acknowledging).
// - Permissions-Policy — deny the powerful features the app doesn't use.
// - Content-Security-Policy — the "public" policy (src/lib/security/csp.ts):
//   scripts only from this origin (no eval), connections only to this origin
//   and Supabase, no plugins, no <base> hijacking, no framing. The signed-in
//   routes the proxy runs on replace it with a per-request nonce policy.
// - Cross-Origin-Opener-Policy — a page that opens or is opened by another
//   site gets no window handle to it (the app opens no cross-origin windows).
const securityHeaders = [
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  },
  {
    key: "Content-Security-Policy",
    value: buildCsp({
      mode: "public",
      dev: process.env.NODE_ENV === "development",
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    }),
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  // SUP-9: every non-Production deployment (Preview branch aliases included)
  // tells crawlers not to index it. Read at build time, like VERCEL_ENV.
  ...indexingHeaders(process.env.VERCEL_ENV),
];

const nextConfig: NextConfig = {
  // SUP-13: no `X-Powered-By: Next.js` banner.
  poweredByHeader: false,
  // Resolve metadata before the document is sent, for every user agent. With
  // streamed metadata, the <title> lives inside a Suspense boundary that a
  // router.refresh() (the fan page refreshes after every reward close)
  // remounts: when the refreshed metadata chunk lands after the tree commits,
  // the document has no <title> at all for a few hundred milliseconds
  // (measured on /spin: axe `document-title` failing intermittently). Blocking
  // costs nothing here: no route has a loading boundary, so the shell already
  // waits for the page, and /spin's viewport awaits the same cached read.
  htmlLimitedBots: /.*/,
  // Tree-shake barrel imports from these packages so only the used symbols are
  // bundled (notably keeps the motion lib from bloating the fan spin page).
  experimental: {
    optimizePackageImports: ["motion", "@supabase/supabase-js"],
  },
  // OPS-12: FF_MAINTENANCE=1 at build time pauses the public site (see
  // src/lib/ops/maintenance.ts). Off: no rewrites at all.
  async rewrites() {
    return { beforeFiles: maintenanceRewrites(process.env), afterFiles: [], fallback: [] };
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // API responses are only ever read by this origin's fetch(); refuse
      // no-cors embedding (<img>/<script> of a signed-in JSON response).
      // RS-04/WA-10: and they are personal by default. Without this, a route
      // that sets no Cache-Control went out as Vercel's `public, max-age=0`;
      // now every /api answer is private and uncacheable unless the route
      // itself says otherwise (a route's own header wins: /api/health keeps
      // its `no-store, max-age=0`, /api/public/wheel/* its short public TTL).
      {
        source: "/api/:path*",
        headers: [
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
          { key: "Cache-Control", value: "private, no-store" },
        ],
      },
      // RM-4: the app service worker. Always revalidated so a fix reaches every
      // device at once, and locked to same-origin scripts.
      {
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'" },
        ],
      },
    ];
  },
};

export default nextConfig;
