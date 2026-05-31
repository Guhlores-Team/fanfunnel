import { notFound } from "next/navigation";
import type { CSSProperties } from "react";
import type { Metadata } from "next";
import { getShareCard } from "@/lib/data";

export const dynamic = "force-dynamic";

const RARITY_LABEL: Record<string, string> = {
  common: "Common",
  uncommon: "Uncommon",
  rare: "Rare",
  epic: "Epic",
  legendary: "Legendary",
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ shareId: string }>;
}): Promise<Metadata> {
  const { shareId } = await params;
  const card = await getShareCard(shareId);
  if (!card) return { title: "Win · FanFunnel" };
  const title = `I won ${card.prizeLabel}! 🎉`;
  const description = `A ${RARITY_LABEL[card.rarity] ?? card.rarity} drop on ${card.creatorTitle}'s wheel.`;
  return {
    title,
    description,
    openGraph: { title, description, images: [`/share/${shareId}/opengraph-image`] },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function SharePage({
  params,
}: {
  params: Promise<{ shareId: string }>;
}) {
  const { shareId } = await params;
  const card = await getShareCard(shareId);
  if (!card) notFound();

  return (
    <main
      className="grain brand-glow relative flex min-h-[100dvh] flex-col items-center justify-center px-5 py-10"
      style={{ "--brand": card.color } as CSSProperties}
    >
      <div className="relative z-[1] w-full max-w-sm">
        <div
          className="card rounded-[1.75rem] p-8 text-center"
          style={{
            boxShadow: `0 30px 80px -20px color-mix(in oklab, ${card.color} 50%, transparent)`,
            borderColor: `color-mix(in oklab, ${card.color} 55%, transparent)`,
          }}
        >
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted">
            {card.creatorTitle}
          </p>
          <span
            className="mt-4 inline-block rounded-full px-3 py-1 text-[11px] font-bold uppercase tracking-[0.14em] text-white"
            style={{ backgroundColor: card.color }}
          >
            {RARITY_LABEL[card.rarity] ?? card.rarity}
          </span>
          {card.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={card.imageUrl}
              alt={card.prizeLabel}
              className="mx-auto my-5 h-40 w-40 rounded-2xl object-cover"
            />
          ) : (
            <div className="my-5 text-6xl">{card.emoji ?? "🎁"}</div>
          )}
          <h1 className="font-[family-name:var(--font-display)] text-2xl font-extrabold text-ink text-balance">
            {card.prizeLabel}
          </h1>
          <p className="mt-3 text-sm text-muted text-pretty">
            Won on {card.creatorTitle}&rsquo;s prize wheel — every spin wins.
          </p>
        </div>
      </div>
      <footer className="relative z-[1] mt-8 text-[11px] tracking-wide text-muted/70">
        Powered by FanFunnel · every spin wins
      </footer>
    </main>
  );
}
