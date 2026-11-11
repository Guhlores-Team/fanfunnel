import { DEFAULT_BRAND } from "@/lib/theme";
import { ICON_VARIANTS, parseIconVariant } from "@/lib/pwa/manifest";
import { renderAppIcon } from "@/lib/pwa/icon";

// PNG icons for the site-wide (creator dashboard) app manifest. No token and
// nothing per-creator, so they are rendered once at build and cached publicly.
export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return Object.keys(ICON_VARIANTS).map((variant) => ({ variant }));
}

export async function GET(_req: Request, { params }: { params: Promise<{ variant: string }> }) {
  const { variant } = await params;
  const spec = parseIconVariant(variant);
  if (!spec) return new Response(null, { status: 404 });
  const png = await renderAppIcon({ ...spec, brand: DEFAULT_BRAND, avatar: null });
  return new Response(png, { headers: { "Content-Type": "image/png" } });
}
