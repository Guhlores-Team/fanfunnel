import { cache } from "react";
import type { Metadata, Viewport } from "next";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { clientIpFromHeaders } from "@/lib/api/clientIp";
import { noteFanMiss } from "@/lib/api/fanMiss";
import { getCreatorThemeView, getFanAppInfo, getFanLinkStatus, getFanPass, getPausedFanWins } from "@/lib/data";
import LinkGone from "@/components/fan/LinkGone";
import PausedWins from "@/components/fan/PausedWins";
import LegalLinks from "@/components/LegalLinks";
import { fanAppName, fanAppPaths, iconVersion } from "@/lib/pwa/manifest";
import SpinClient from "@/components/SpinClient";
import SafetyMenu from "@/components/fan/SafetyMenu";
import { LinkPauseProvider } from "@/components/fan/LinkPauseProvider";
import { themeStyle } from "@/lib/creatorTheme/tokens";
import { themeFontFamily } from "@/lib/creatorTheme/fonts";
import ThemeBackdrop from "@/components/theme/ThemeBackdrop";
import PhotoGallery from "@/components/theme/PhotoGallery";
import { NoScriptNote } from "@/components/fan/FanGameController";

// Fan-facing page. The token in the URL is the fan's secret pass.
export const dynamic = "force-dynamic";
// OPS3-02: the reads behind this page carry their own deadlines (src/lib/data/unavailable.ts);
// this caps the whole invocation so a stuck one ends with our page, not the platform's.
export const maxDuration = 15;

// RM-4: this page links ITS OWN manifest (installs this fan's link, not the
// dashboard app) and is never indexed. One read shared by both exports below.
const appInfo = cache(getFanAppInfo);
// C2: the per-address budget for link lookups that miss (src/lib/api/fanMiss.ts).
// ATK-04: the lookup always runs (a valid link behind a shared address must
// open); only a genuine miss is counted, after the lookup.
const visitorIp = cache(async () => clientIpFromHeaders(await headers()));

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
  if (!pass) {
    // T3: a link the fan paused is permanent, but keeps a read-only list of
    // its wins (no SPIN, no chat) instead of a 404.
    const paused = await getPausedFanWins(token);
    if (paused) return <PausedWins token={token} view={paused} />;
    // A link whose creator left, or whose fan deleted their data, says so.
    // Anything else (switched off, blocked by a suspension, unknown) is the
    // 404, which still offers the fan's data controls (./not-found.tsx).
    const status = await getFanLinkStatus(token);
    if (!status) {
      await noteFanMiss(await visitorIp());
      notFound();
    }
    return <LinkGone status={status} />;
  }

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
      <div className="relative z-40 w-full max-w-md"><NoScriptNote /></div>
      <LinkPauseProvider initialBreakUntil={pass.play?.breakUntil ?? null}>
        {/* z-40: the fan UI (and every fixed overlay inside it: reward reveal,
            saved-reward and break dialogs) paints above the backdrop and above
            the Preview-only EnvBadge (z-30), which must never cover a fan's
            action. Those overlays' own z-index only orders them inside here. */}
        <div className="relative z-40 flex w-full justify-center">
          <SpinClient
            pass={pass}
            gallery={look.media.length ? <PhotoGallery media={look.media} creatorTitle={pass.creatorTitle} /> : null}
          />
        </div>
        {/* Paints above the EnvBadge like the fan UI, so mid-scroll its muted
            text can cross the badge band; the opaque theme-colour backing keeps
            that text at its contrast on the page instead of on the badge. */}
        <footer
          className="relative z-40 mt-10 flex flex-col items-center gap-2 rounded-2xl px-3 py-1.5 text-center text-[11px] tracking-wide text-muted"
          style={{ backgroundColor: "var(--theme-bg)" }}
        >
          <span>Powered by FanFunnel · every spin lands on a prize</span>
          <SafetyMenu token={token} />
          <LegalLinks />
        </footer>
      </LinkPauseProvider>
    </main>
  );
}
