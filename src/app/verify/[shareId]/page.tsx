import type { Metadata } from "next";
import { getSpinVerification } from "@/lib/data";
import type { SeedCommitment } from "@/lib/data/types";
import { brandVars } from "@/lib/theme";
import { RARITY_COLORS } from "@/lib/games/wheel/types";

export const dynamic = "force-dynamic";

const RARITY_LABEL: Record<string, string> = {
  common: "Common",
  uncommon: "Uncommon",
  rare: "Rare",
  epic: "Epic",
  legendary: "Legendary",
};

/**
 * What a matching hash proves depends on HOW the spin got its seed. Only a
 * `published` commitment carries the full "fixed before you spun" guarantee;
 * the other cases say so instead of borrowing that claim.
 */
const COMMITMENT_COPY: Record<
  SeedCommitment | "unknown",
  { label: string; verdict: string; strong: boolean }
> = {
  published: {
    label: "Published before your spin",
    verdict:
      "This result was committed before it was revealed — the seed's hash was on your spin page before you spun, and the seed wasn't swapped after the spin.",
    strong: true,
  },
  stored: {
    label: "Committed in a concurrent spin",
    verdict:
      "Two spins were in flight on this link. This seed was committed on the server before this spin consumed it, so it couldn't be chosen after seeing your request — but its hash reached you in the other spin's response, not on your spin page before this one.",
    strong: true,
  },
  fresh: {
    label: "Generated at spin time",
    verdict:
      "The seed and its hash are consistent, but this seed was generated when you spun and its hash was not published in advance — so this check alone doesn't prove the outcome was fixed before your spin.",
    strong: false,
  },
  unknown: {
    label: "Not recorded",
    verdict:
      "The seed and its hash are consistent, but this spin predates commitment tracking, so we can't show that its hash was published before you spun (older spins may also use an earlier RNG derivation).",
    strong: false,
  },
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
        style={brandVars("#6366f1")}
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
  const commitment = COMMITMENT_COPY[v.commitment ?? "unknown"];
  // Green only when the hash matches AND the commitment was fixed in advance;
  // a consistent-but-unpublished pair is amber; a mismatch is red.
  const verdictColor = !v.hashOk ? "#ef4444" : commitment.strong ? "#22c55e" : "#f59e0b";

  return (
    <main
      className="grain brand-glow relative flex min-h-[100dvh] flex-col items-center justify-center px-5 py-10"
      style={brandVars(color)}
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
              borderColor: `color-mix(in oklab, ${verdictColor} 55%, transparent)`,
              backgroundColor: `color-mix(in oklab, ${verdictColor} 12%, transparent)`,
            }}
          >
            <p className="text-sm font-bold text-ink">
              {v.hashOk ? "✓ Hash matches" : "✗ Mismatch"}
            </p>
            <p className="mt-1 text-xs text-muted text-pretty">
              {v.hashOk
                ? commitment.verdict
                : "The revealed seed does not hash to the committed value. This commitment can't be trusted."}
            </p>
          </div>

          {/* The commitment's provenance + hash + revealed seed + nonce. */}
          <dl className="mt-6 space-y-4 text-sm">
            <div>
              <dt className="text-xs font-medium uppercase tracking-[0.14em] text-muted">
                Commitment
              </dt>
              <dd className="mt-1 text-xs text-ink">{commitment.label}</dd>
            </div>
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
            How it works: for a committed spin the server fixes the random seed
            <strong className="text-ink"> before</strong> you spin, by publishing
            its SHA-256 hash on your spin page. Your browser contributes its own
            seed, so neither side can dictate the outcome alone. The result is
            drawn from{" "}
            <code className="font-mono text-[10px] text-ink">
              SHA-256(serverSeed:clientSeed:nonce:block)
            </code>
            . After the spin the seed is revealed; when re-hashing it reproduces
            a hash you saw <strong className="text-ink">before</strong> spinning,
            the outcome couldn&rsquo;t have been changed after the fact. The
            &ldquo;Commitment&rdquo; line above says whether that applies to this
            spin. This verifies the
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
