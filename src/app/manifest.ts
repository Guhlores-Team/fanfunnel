import type { MetadataRoute } from "next";

// PWA manifest so fans can add the spin page to their home screen and it feels
// like an app. Brand-neutral at the app level; the per-creator brand color
// drives the in-page experience.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "FanFunnel",
    short_name: "FanFunnel",
    description: "Spin to win — every spin wins a prize.",
    start_url: "/",
    display: "standalone",
    background_color: "#0c0a0e",
    theme_color: "#0c0a0e",
    icons: [
      { src: "/favicon.ico", sizes: "any", type: "image/x-icon" },
    ],
  };
}
