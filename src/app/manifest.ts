import type { MetadataRoute } from "next";
import { buildRootManifest } from "@/lib/pwa/manifest";

// Site-wide manifest, linked from every page except a fan's /spin/<token> page
// (which links its own per-link manifest). It is the creator dashboard app:
// start_url /dashboard (sign-in first when signed out), PNG icons. Web push
// reuses it, since iPhones only allow push for apps on the home screen.
export default function manifest(): MetadataRoute.Manifest {
  return buildRootManifest();
}
