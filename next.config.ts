import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Tree-shake barrel imports from these packages so only the used symbols are
  // bundled (notably keeps the motion lib from bloating the fan spin page).
  experimental: {
    optimizePackageImports: ["motion", "@supabase/supabase-js"],
  },
};

export default nextConfig;
