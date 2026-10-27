import { getFanAppInfo } from "@/lib/data";
import { buildFanManifest, isValidFanToken } from "@/lib/pwa/manifest";
import { fanAppHeaders, fanAppNotFound, fanAppRateLimit } from "@/lib/pwa/fanAppRoute";

// The per-link web app manifest (RM-4): installs THIS fan's link, opening
// straight to their wheel. Linked only from /spin/<token> itself.
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const limited = await fanAppRateLimit(req);
  if (limited) return limited;

  const { token } = await params;
  if (!isValidFanToken(token)) return fanAppNotFound();
  const info = await getFanAppInfo(token);
  if (!info) return fanAppNotFound();

  return new Response(JSON.stringify(buildFanManifest(token, info)), {
    headers: fanAppHeaders("application/manifest+json"),
  });
}
