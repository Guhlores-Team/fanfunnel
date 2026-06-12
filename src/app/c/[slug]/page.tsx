import { notFound } from "next/navigation";
import type { CSSProperties } from "react";
import type { Metadata } from "next";
import { getPublicProfileBySlug } from "@/lib/data";
import { externalUrl } from "@/lib/format";
import { RARITY_COLORS } from "@/lib/games/wheel/types";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const data = await getPublicProfileBySlug(slug);
  if (!data) return { title: "FanFunnel" };
  const title = `${data.profile.creatorTitle} · Prize Wheel`;
  const description =
    data.profile.tagline ?? "Spin to win — every spin wins a prize. 🎡";
  return {
    title,
    description,
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
  if (!data) notFound();
  const { profile, tipUrl } = data;

  return (
    <main
      className="grain brand-glow relative flex min-h-[100dvh] flex-col items-center justify-center px-5 py-12"
      style={{ "--brand": profile.brandColor } as CSSProperties}
    >
      <div className="relative z-[1] w-full max-w-md text-center">
        {profile.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- remote creator avatar
          <img
            src={profile.avatarUrl}
            alt={profile.creatorTitle}
            className="mx-auto mb-6 h-20 w-20 rounded-full object-cover ring-2 ring-[var(--brand)]"
          />
        ) : (
          <div
            aria-hidden
            className="mx-auto mb-6 grid h-20 w-20 place-items-center rounded-full text-4xl"
            style={{
              background: `radial-gradient(circle, color-mix(in oklab, var(--brand) 40%, transparent), transparent 70%)`,
            }}
          >
            🎡
          </div>
        )}
        <h1 className="font-[family-name:var(--font-display)] text-3xl font-extrabold text-ink">
          {profile.creatorTitle}
        </h1>
        <p className="mx-auto mt-2 max-w-sm text-sm text-muted text-pretty">
          {profile.tagline ?? "Spin my wheel — every spin wins a prize. 🎁"}
        </p>

        {profile.prizes.length > 0 && (
          <div className="mt-7">
            <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted">
              What you could win
            </p>
            <div className="mt-3 flex flex-wrap justify-center gap-2">
              {profile.prizes.map((p) => {
                const c = RARITY_COLORS[p.rarity];
                return (
                  <span
                    key={p.label}
                    className="rounded-full px-3 py-1 text-xs font-semibold text-ink"
                    style={{
                      backgroundColor: `color-mix(in oklab, ${c} 16%, transparent)`,
                      border: `1px solid color-mix(in oklab, ${c} 50%, transparent)`,
                    }}
                  >
                    {p.emoji ?? "🎁"} {p.label}
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
            Get your spins →
          </a>
        ) : (
          <p className="mt-8 text-sm text-muted">
            DM {profile.creatorTitle} to get your personal spin link.
          </p>
        )}
        <p className="mt-3 text-xs text-muted/70">
          Every spin wins · rare drops keep it exciting
        </p>
      </div>
      <footer className="relative z-[1] mt-10 text-[11px] tracking-wide text-muted/70">
        Powered by FanFunnel
      </footer>
    </main>
  );
}
