import { cache } from "react";
import type { Metadata, Viewport } from "next";
import { notFound } from "next/navigation";
import { getFanAppInfo, getFanPass } from "@/lib/data";
import { fanAppName, fanAppPaths, iconVersion } from "@/lib/pwa/manifest";
import SpinClient from "@/components/SpinClient";
import SafetyMenu from "@/components/fan/SafetyMenu";
import { LinkPauseProvider } from "@/components/fan/LinkPauseProvider";
import { brandVars } from "@/lib/theme";

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
  // like THEIRS, not FanFunnel's.
  const brand = pass.wheel.brandColor ?? "#ec4899";

  return (
    <main
      className="grain brand-glow relative flex min-h-[100dvh] flex-col items-center justify-center px-5 pt-10 pb-28"
      style={brandVars(brand)}
    >
      <LinkPauseProvider>
        <div className="relative z-[1] flex w-full justify-center">
          <SpinClient pass={pass} />
        </div>
        <footer className="relative z-[1] mt-10 flex flex-col items-center gap-2 text-center text-[11px] tracking-wide text-muted/70">
          <span>Powered by FanFunnel · every spin wins</span>
          <SafetyMenu token={token} />
        </footer>
      </LinkPauseProvider>
    </main>
  );
}
