import { getFanAppInfo } from "@/lib/data";
import { isValidFanToken, parseIconVariant, usesAvatarIcon } from "@/lib/pwa/manifest";
import { loadAvatarDataUrl, renderAppIcon } from "@/lib/pwa/icon";
import { fanAppHeaders, fanAppNotFound, fanAppRateLimit } from "@/lib/pwa/fanAppRoute";

// Home-screen icons for one fan link (RM-4): the neutral wheel glyph on the
// brand colour, or the creator's avatar when they chose it (D8). Variants:
// 180 (apple-touch-icon), 192, 512, maskable-192, maskable-512.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string; variant: string }> }
) {
  const limited = await fanAppRateLimit(req);
  if (limited) return limited;

  const { token, variant } = await params;
  const spec = parseIconVariant(variant);
  if (!spec || !isValidFanToken(token)) return fanAppNotFound();
  const info = await getFanAppInfo(token);
  if (!info) return fanAppNotFound();

  const avatar = usesAvatarIcon(info) ? await loadAvatarDataUrl(info.avatarUrl!) : null;
  const png = await renderAppIcon({ ...spec, brand: info.brandColor, avatar });
  return new Response(png, { headers: fanAppHeaders("image/png") });
}
