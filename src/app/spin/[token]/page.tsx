import { cache } from "react";
import type { Metadata, Viewport } from "next";
import { notFound } from "next/navigation";
import { getCreatorThemeView, getFanAppInfo, getFanPass } from "@/lib/data";
import { fanAppName, fanAppPaths, iconVersion } from "@/lib/pwa/manifest";
import SpinClient from "@/components/SpinClient";
import SafetyMenu from "@/components/fan/SafetyMenu";
import { LinkPauseProvider } from "@/components/fan/LinkPauseProvider";
import { themeStyle } from "@/lib/creatorTheme/tokens";
import { themeFontFamily } from "@/lib/creatorTheme/fonts";
import ThemeBackdrop from "@/components/theme/ThemeBackdrop";
import PhotoGallery from "@/components/theme/PhotoGallery";

// Fan-facing page. The token in the URL is the fan's secret pass.
export const dynamic = "force-dynamic";

// RM-4: this page links ITS OWN manifest (installs this fan's link, not the
// dashboard app) and is never indexed. One read shared by both exports below.
const appInfo = cache(getFanAppInfo);

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  const robots = { index: false, follow: false };
  const info = await appInfo(token);
  // Unknown or ended link: no install surface at all (the page 404s).
  if (!info) return { robots, manifest: null };
  const paths = fanAppPaths(token);
  return {
    robots,
    manifest: paths.manifest,
    icons: { apple: `${paths.icon("180")}?v=${iconVersion(info)}` },
    appleWebApp: { capable: true, title: fanAppName(info), statusBarStyle: "black" },
  };
}

export async function generateViewport({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Viewport> {
  const info = await appInfo((await params).token);
  return info ? { themeColor: info.brandColor } : {};
}

export default async function SpinPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const pass = await getFanPass(token);
  if (!pass) notFound();

  // The creator's brand color drives the whole page — every fan page feels
  // like THEIRS, not FanFunnel's. Their theme (headline font, background,
  // photo hub) layers on top; tokens.ts keeps every text pairing AA.
  const brand = pass.wheel.brandColor ?? "#ec4899";
  const look = await getCreatorThemeView(pass.creatorId);
  const { style, plan } = themeStyle(look.theme, brand, themeFontFamily(look.theme.font));

  return (
    <main
      className="relative flex min-h-[100dvh] flex-col items-center justify-center px-5 pt-10 pb-28"
      style={style}
      data-theme-font={look.theme.font}
      data-theme-background={look.theme.background}
    >
      <ThemeBackdrop bgUrl={look.bgUrl} heavyGrain={plan.grains.length > 1} />
      <LinkPauseProvider initialBreakUntil={pass.play?.breakUntil ?? null}>
        <div className="relative z-[1] flex w-full justify-center">
          <SpinClient
            pass={pass}
            gallery={look.media.length ? <PhotoGallery media={look.media} creatorTitle={pass.creatorTitle} /> : null}
          />
        </div>
        <footer className="relative z-[1] mt-10 flex flex-col items-center gap-2 text-center text-[11px] tracking-wide text-muted">
          <span>Powered by FanFunnel · every spin wins</span>
          <SafetyMenu token={token} />
        </footer>
      </LinkPauseProvider>
    </main>
  );
}
