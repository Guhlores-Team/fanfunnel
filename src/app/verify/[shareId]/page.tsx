import type { CSSProperties } from "react";
import type { Metadata } from "next";
import { getSpinVerification } from "@/lib/data";
import { RARITY_COLORS } from "@/lib/games/wheel/types";

export const dynamic = "force-dynamic";

const RARITY_LABEL: Record<string, string> = {
  common: "Common",
  uncommon: "Uncommon",
  rare: "Rare",
  epic: "Epic",
  legendary: "Legendary",
};

export const metadata: Metadata = { title: "Verify fairness · FanFunnel" };

export default async function VerifyPage({
  params,
}: {
  params: Promise<{ shareId: string }>;
}) {
  const { shareId } = await params;
  const v = await getSpinVerification(shareId);

  // Nothing to verify: unknown share id, or a spin with no committed seed.
  if (!v) {
    return (
      <main
        className="grain brand-glow relative flex min-h-[100dvh] flex-col items-center justify-center px-5 py-10"
        style={{ "--brand": "#6366f1" } as CSSProperties}
      >
        <div className="relative z-[1] w-full max-w-md">
          <div className="card rounded-[1.75rem] p-8 text-center">
            <div className="text-5xl">🔍</div>
            <h1 className="mt-4 font-[family-name:var(--font-display)] text-xl font-extrabold text-ink">
              Nothing to verify
            </h1>
            <p className="mt-3 text-sm text-muted text-pretty">
              We couldn&rsquo;t find a verifiable spin for this link. It may be an
              older spin recorded before fairness commitments, or the link is
              invalid.
            </p>
          </div>
        </div>
        <footer className="relative z-[1] mt-8 text-[11px] tracking-wide text-muted/70">
          Powered by FanFunnel · provably-fair spins
        </footer>
      </main>
    );
  }

  const color = RARITY_COLORS[v.rarity];

  return (
    <main
      className="grain brand-glow relative flex min-h-[100dvh] flex-col items-center justify-center px-5 py-10"
      style={{ "--brand": color } as CSSProperties}
    >
      <div className="relative z-[1] w-full max-w-md">
        <div
          className="card rounded-[1.75rem] p-8"
          style={{
            borderColor: `color-mix(in oklab, ${color} 45%, transparent)`,
          }}
        >
          <p className="text-center text-xs font-medium uppercase tracking-[0.18em] text-muted">
            Fairness check
          </p>

          <div className="mt-4 text-center">
            <span
              className="inline-block rounded-full px-3 py-1 text-[11px] font-bold uppercase tracking-[0.14em] text-white"
              style={{ backgroundColor: color }}
            >
              {RARITY_LABEL[v.rarity] ?? v.rarity}
            </span>
            <h1 className="mt-3 font-[family-name:var(--font-display)] text-2xl font-extrabold text-ink text-balance">
              {v.prizeLabel}
            </h1>
            <p className="mt-1 text-xs text-muted">
              {new Date(v.at).toLocaleString()}
            </p>
          </div>

          {/* Verdict */}
          <div
            className="mt-6 rounded-xl border p-4 text-center"
            style={{
              borderColor: v.hashOk
                ? "color-mix(in oklab, #22c55e 55%, transparent)"
                : "color-mix(in oklab, #ef4444 55%, transparent)",
              backgroundColor: v.hashOk
                ? "color-mix(in oklab, #22c55e 12%, transparent)"
                : "color-mix(in oklab, #ef4444 12%, transparent)",
            }}
          >
            <p className="text-sm font-bold text-ink">
              {v.hashOk ? "✓ Hash matches" : "✗ Mismatch"}
            </p>
            <p className="mt-1 text-xs text-muted text-pretty">
              {v.hashOk
                ? "This result was committed before it was revealed — the server seed wasn't swapped after the spin."
                : "The revealed seed does not hash to the committed value. This commitment can't be trusted."}
            </p>
          </div>

          {/* The committed hash + revealed seed + nonce. */}
          <dl className="mt-6 space-y-4 text-sm">
            <div>
              <dt className="text-xs font-medium uppercase tracking-[0.14em] text-muted">
                Committed hash (SHA-256)
              </dt>
              <dd className="mt-1 break-all rounded-lg border border-line bg-surface px-3 py-2 font-mono text-xs text-ink">
                {v.serverSeedHash}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-[0.14em] text-muted">
                Revealed server seed
              </dt>
              <dd className="mt-1 break-all rounded-lg border border-line bg-surface px-3 py-2 font-mono text-xs text-ink">
                {v.serverSeed}
              </dd>
            </div>
            {v.clientSeed ? (
              <div>
                <dt className="text-xs font-medium uppercase tracking-[0.14em] text-muted">
                  Your client seed
                </dt>
                <dd className="mt-1 break-all rounded-lg border border-line bg-surface px-3 py-2 font-mono text-xs text-ink">
                  {v.clientSeed}
                </dd>
              </div>
            ) : null}
            <div>
              <dt className="text-xs font-medium uppercase tracking-[0.14em] text-muted">
                Nonce
              </dt>
              <dd className="tnum mt-1 font-mono text-xs text-ink">{v.nonce}</dd>
            </div>
          </dl>

          <p className="mt-6 text-[11px] leading-relaxed text-muted/80 text-pretty">
            How it works: the server committed to this spin&rsquo;s random seed
            <strong className="text-ink"> before</strong> you spun, by publishing
            its SHA-256 hash on your spin page. Your browser contributed its own
            seed, so neither side could dictate the outcome alone. The result was
            drawn from{" "}
            <code className="font-mono text-[10px] text-ink">
              SHA-256(serverSeed:clientSeed:nonce:block)
            </code>
            . After the spin the seed was revealed; because re-hashing it
            reproduces the committed hash, the outcome couldn&rsquo;t have been
            changed after the fact. This verifies the
            <strong className="text-ink"> commitment&rsquo;s integrity</strong>;
            it does not re-simulate the full prize pool.
          </p>
        </div>
      </div>
      <footer className="relative z-[1] mt-8 text-[11px] tracking-wide text-muted/70">
        Powered by FanFunnel · provably-fair spins
      </footer>
    </main>
  );
}
