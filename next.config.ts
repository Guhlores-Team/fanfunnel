import type { NextConfig } from "next";

// Security response headers applied to every route. Rationale:
// - Referrer-Policy: strict-origin-when-cross-origin — never send the full URL
//   (which for a fan is `/spin/<secret-token>`) to a third party; only the bare
//   origin leaves the site. Stops the spin token leaking via the Referer header.
// - X-Content-Type-Options: nosniff — no MIME sniffing of API/JSON/upload bytes.
// - X-Frame-Options + CSP frame-ancestors — the app is never meant to be framed;
//   blocks clickjacking (e.g. tricking a fan into spinning/acknowledging).
// - Permissions-Policy — deny the powerful features the app doesn't use.
// - base-uri/object-src via CSP — neutralise <base> hijacking and plugin embeds.
//   (A full script-src CSP is intentionally omitted here — it needs per-route
//   nonces to not break Next's inline bootstrap; tracked as a follow-up.)
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
    value: "frame-ancestors 'self'; base-uri 'self'; object-src 'none'",
  },
];

const nextConfig: NextConfig = {
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
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
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
