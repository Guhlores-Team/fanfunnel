import { cache } from "react";
import type { Metadata } from "next";
import LegalLinks from "@/components/LegalLinks";
import { getLeaderboard } from "@/lib/data";
import { brandVars } from "@/lib/theme";
import { linkNotFound } from "@/lib/fan/linkNotFound";

export const dynamic = "force-dynamic";
// OPS3-02: the reads behind this page carry their own deadlines (src/lib/data/unavailable.ts);
// this caps the whole invocation so a stuck one ends with our page, not the platform's.
export const maxDuration = 15;

// One read shared by the metadata and the page.
const board = cache(getLeaderboard);

// WA-07 / WA-11 / WA-06: the fan's board, not creator marketing; by link only; not an app.
export async function generateMetadata({ params }: { params: Promise<{ creatorId: string }> }): Promise<Metadata> {
  const view = await board((await params).creatorId);
  return {
    title: view ? `${view.creatorTitle} · Leaderboard` : "Leaderboard · FanFunnel",
    description: "Top fans by plays and rare wins, by board name only.",
    robots: { index: false, follow: false },
    manifest: null,
  };
}

export default async function LeaderboardPage({
  params,
}: {
  params: Promise<{ creatorId: string }>;
}) {
  const { creatorId } = await params;
  const view = await board(creatorId);
  // L5: an unknown, suspended or unapproved creator has no board (WA-02: the branded 404).
  if (!view) linkNotFound("leaderboard", creatorId);

  return (
    <main
      className="grain brand-glow relative flex min-h-[100dvh] flex-col items-center px-5 py-12"
      style={brandVars("#ec4899")}
    >
      <div className="relative z-[1] w-full max-w-md">
        <header className="text-center">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted">
            {view.creatorTitle}
          </p>
          <h1 className="mt-2 font-[family-name:var(--font-display)] text-3xl font-extrabold text-ink">
            Leaderboard
          </h1>
        </header>

        {!view.enabled || view.entries.length === 0 ? (
          <p className="mt-12 text-center text-sm text-muted">
            {view.enabled
              ? "No ranked fans yet — be the first to climb."
              : "This creator hasn't opened their leaderboard."}
          </p>
        ) : (
          <ol className="mt-8 space-y-2">
            {view.entries.map((e) => (
              <li
                key={e.rank}
                className="card flex items-center gap-4 rounded-2xl px-4 py-3"
              >
                <span
                  className={`tnum w-8 text-center text-lg font-extrabold ${
                    e.rank <= 3 ? "text-brand" : ""
                  }`}
                >
                  {e.rank}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-ink">{e.handle}</p>
                  <p className="text-xs text-muted">
                    {e.rareWins} rare {e.rareWins === 1 ? "win" : "wins"}
                  </p>
                </div>
                <span className="tnum shrink-0 text-sm font-bold text-ink">
                  {e.spins} <span className="text-xs font-normal text-muted">spins</span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
      <footer className="relative z-[1] mt-10 text-xs tracking-wide text-muted">
        Powered by FanFunnel
      </footer>
      <LegalLinks className="relative z-[1] mt-2" />
    </main>
  );
}
