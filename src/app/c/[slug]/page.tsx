import LegalLinks from "@/components/LegalLinks";
import { linkNotFound } from "@/lib/fan/linkNotFound";
import { formatChance } from "@/lib/games/wheel/publicOdds";
import type { Metadata } from "next";
import { getPublicProfileBySlug } from "@/lib/data";
import { themeStyle } from "@/lib/creatorTheme/tokens";
import { themeFontFamily } from "@/lib/creatorTheme/fonts";
import ThemeBackdrop from "@/components/theme/ThemeBackdrop";
import PhotoGallery from "@/components/theme/PhotoGallery";
import ReportPhoto from "@/components/theme/ReportPhoto";
import { externalUrl } from "@/lib/format";
import { RARITY_COLORS } from "@/lib/games/wheel/types";
import { isPublicPrizeAvailable } from "@/lib/games/wheel/publicView";
import { hasStockToShow, stockLabel } from "@/components/fan/stockDisplay";
import { publicGameCopy } from "@/lib/games/publicCopy";

// ISR: public, viewer-independent data (service-client read, no cookies or
// headers), so each slug renders on first visit and is re-generated at most
// once a minute; profile/wheel edits show up within that window.
export const revalidate = 60;

// No slugs prerendered at build; returning [] (rather than omitting this) is
// what lets the route be cached at runtime instead of rendered per request.
export function generateStaticParams() {
  return [];
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const data = await getPublicProfileBySlug(slug);
  // WA-06: a creator's public page is not the creator-dashboard app.
  if (!data) return { title: "FanFunnel", manifest: null };
  const copy = publicGameCopy(data.profile.gameKind);
  const title = `${data.profile.creatorTitle} · ${copy.titleSuffix}`;
  const description = data.profile.tagline ?? copy.metaDescription;
  return {
    title,
    description,
    manifest: null,
    openGraph: { title, description },
    twitter: { card: "summary_large_image", title, description },
  };
}

// SFW, postable link-in-bio landing page. No explicit media — just the brand,
// a prize teaser, and a call to action. Safe to drop in an Instagram bio.
export default async function PublicProfilePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const data = await getPublicProfileBySlug(slug);
  if (!data) linkNotFound("c", slug);
  const { profile, tipUrl } = data;
  const { look } = profile;
  const copy = publicGameCopy(profile.gameKind);
  const { style, plan } = themeStyle(look.theme, profile.brandColor, themeFontFamily(look.theme.font));

  return (
    <main
      className="relative flex min-h-[100dvh] flex-col items-center justify-center px-5 py-12"
      style={style}
      data-theme-font={look.theme.font}
      data-theme-background={look.theme.background}
    >
      <ThemeBackdrop bgUrl={look.bgUrl} heavyGrain={plan.grains.length > 1} />
      <div className="relative z-[1] w-full max-w-md text-center">
        {profile.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- remote creator avatar
          <img
            src={profile.avatarUrl}
            alt={profile.creatorTitle}
            className="mx-auto mb-6 h-20 w-20 rounded-full object-cover ring-2 ring-[var(--brand-ui)]"
          />
        ) : (
          <div
            aria-hidden
            className="mx-auto mb-6 grid h-20 w-20 place-items-center rounded-full text-4xl"
            style={{
              background: `radial-gradient(circle, color-mix(in oklab, var(--brand-ui) 40%, transparent), transparent 70%)`,
            }}
          >
            {copy.emoji}
          </div>
        )}
        <h1 className="font-[family-name:var(--font-display)] text-3xl font-extrabold text-ink">
          {profile.creatorTitle}
        </h1>
        <p className="mx-auto mt-2 max-w-sm text-sm text-muted text-pretty">
          {profile.tagline ?? copy.defaultTagline}
        </p>

        {profile.prizes.length > 0 && (
          <div className="mt-7">
            <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted">
              What you could win
            </p>
            <div className="mt-3 flex flex-wrap justify-center gap-2">
              {profile.prizes.map((p) => {
                const c = RARITY_COLORS[p.rarity];
                // RM-2: the real count (only when the wheel shows stock), or
                // the sold-out wording; sold out reads muted, not faded.
                const gone = !isPublicPrizeAvailable(p);
                return (
                  <span
                    key={p.label}
                    data-testid="teaser-prize"
                    className={`rounded-full px-3 py-1 text-xs font-semibold ${gone ? "border border-line text-muted" : "text-ink"}`}
                    style={
                      gone
                        ? undefined
                        : {
                            backgroundColor: `color-mix(in oklab, ${c} 16%, transparent)`,
                            border: `1px solid color-mix(in oklab, ${c} 50%, transparent)`,
                          }
                    }
                  >
                    {p.emoji ?? "🎁"} {p.label}
                    {hasStockToShow(p) && (
                      <span className="tnum font-normal"> · {stockLabel(p)}</span>
                    )}
                  </span>
                );
              })}
            </div>
          </div>
        )}

        {tipUrl ? (
          <a
            href={externalUrl(tipUrl)}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-brand mt-8 inline-block w-full rounded-2xl py-4 text-lg font-extrabold"
          >
            {copy.cta}
          </a>
        ) : (
          <p className="mt-8 text-sm text-muted">
            {copy.dmLine(profile.creatorTitle)}
          </p>
        )}
        <p className="mt-3 text-xs text-muted">
          {copy.everyPlayWins}
        </p>
        {profile.odds.length > 0 && (
          <details className="mx-auto mt-2 max-w-sm text-left text-xs text-muted" data-testid="public-odds">
            <summary className="mx-auto w-fit min-h-6 cursor-pointer text-center underline underline-offset-4 hover:text-ink">
              See the odds
            </summary>
            <ul className="mt-2 space-y-1">
              {profile.odds.map((row, i) => (
                <li key={`${row.label}-${i}`} className="flex justify-between gap-3">
                  <span className="min-w-0 break-words text-ink">{row.label}</span>
                  <span className="tnum shrink-0">{formatChance(row.chance)}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2">Base odds for a new play. Your page shows your exact odds before each spin.</p>
          </details>
        )}
        {look.media.length > 0 && (
          <div className="mt-8">
            <PhotoGallery media={look.media} creatorTitle={profile.creatorTitle} />
            <ReportPhoto slug={slug} media={look.media} />
          </div>
        )}
      </div>
      <footer className="relative z-[1] mt-10 text-[11px] tracking-wide text-muted">
        Powered by FanFunnel
      </footer>
      <LegalLinks className="relative z-[1] mt-2" />
    </main>
  );
}
