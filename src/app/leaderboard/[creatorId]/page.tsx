import { getLeaderboard } from "@/lib/data";
import { brandVars } from "@/lib/theme";

export const dynamic = "force-dynamic";

export default async function LeaderboardPage({
  params,
}: {
  params: Promise<{ creatorId: string }>;
}) {
  const { creatorId } = await params;
  const view = await getLeaderboard(creatorId);

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
      <footer className="relative z-[1] mt-10 text-[11px] tracking-wide text-muted/70">
        Powered by FanFunnel
      </footer>
    </main>
  );
}
