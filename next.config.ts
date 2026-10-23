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
  // Tree-shake barrel imports from these packages so only the used symbols are
  // bundled (notably keeps the motion lib from bloating the fan spin page).
  experimental: {
    optimizePackageImports: ["motion", "@supabase/supabase-js"],
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
