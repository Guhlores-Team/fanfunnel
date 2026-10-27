import type { Metadata } from "next";
import { getSpinVerification } from "@/lib/data";
import { COMMITMENT_COPY, verdictColor } from "./commitmentCopy";
import { brandVars, readableInk } from "@/lib/theme";
import { RARITY_COLORS } from "@/lib/games/wheel/types";
import { replayV3 } from "@/lib/games/wheel/fairnessV3";
import { OddsUsed } from "./OddsUsed";
import { V3_FORMULA } from "./oddsCopy";

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
  // fair_version selects the check: a v3 spin is replayed end to end from its
  // recorded odds; v1/v2 (and untracked) spins are verified by their seed
  // hash exactly as before.
  const replay =
    v.fairVersion === 3 && v.v3
      ? await replayV3({
          serverSeed: v.serverSeed,
          clientSeed: v.clientSeed ?? null,
          nonce: v.nonce,
          snapshot: v.v3.poolSnapshot,
          poolHash: v.v3.poolHash,
          trace: v.v3.fairTrace,
          prizeId: v.v3.prizeId,
          prizeLabel: v.prizeLabel,
        })
      : null;
  const oddsOk = replay ? replay.ok : true;
  const verdict = verdictColor(v.hashOk && oddsOk, v.commitment);

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
              className="inline-block rounded-full px-3 py-1 text-[11px] font-bold uppercase tracking-[0.14em]"
              style={{ backgroundColor: color, color: readableInk(color) }}
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
              borderColor: `color-mix(in oklab, ${verdict} 55%, transparent)`,
              backgroundColor: `color-mix(in oklab, ${verdict} 12%, transparent)`,
            }}
          >
            <p className="text-sm font-bold text-ink">
              {!v.hashOk ? "✗ Mismatch" : oddsOk ? "✓ Hash matches" : "✗ Odds don't replay"}
            </p>
            <p className="mt-1 text-xs text-muted text-pretty">
              {!v.hashOk
                ? "The revealed seed does not hash to the committed value. This commitment can't be trusted."
                : oddsOk
                  ? commitment.verdict
                  : "The seed hash matches, but replaying the recorded odds doesn't reproduce this result, so this spin can't be trusted."}
            </p>
          </div>

          {replay ? <OddsUsed replay={replay} poolHash={v.v3?.poolHash ?? null} /> : null}

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

          {replay ? (
            <p className="mt-6 text-[11px] leading-relaxed text-muted/80 text-pretty">
              How it works: for a committed spin the server fixes the random seed
              <strong className="text-ink"> before</strong> you spin, by publishing
              its SHA-256 hash on your spin page. Your browser contributes its own
              seed, so neither side can dictate the outcome alone. When the spin
              runs, the exact odds are recorded and fingerprinted, and the result
              is drawn from{" "}
              <code className="font-mono text-[10px] text-ink">{V3_FORMULA}</code>
              , where <code className="font-mono text-[10px] text-ink">poolHash</code>{" "}
              is the odds fingerprint. This page re-hashes the seed and the odds,
              rebuilds every random number and replays the draw; it passes only
              when the replay lands on the prize you won. The
              &ldquo;Commitment&rdquo; line above says whether the seed was fixed
              before you spun.
            </p>
          ) : (
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
            a hash you saw <strong className="text-ink">before</strong>{" "}
            spinning, the outcome couldn&rsquo;t have been changed after the fact. The
            &ldquo;Commitment&rdquo; line above says whether that applies to this
            spin. This verifies the
            <strong className="text-ink"> commitment&rsquo;s integrity</strong>;
            it does not re-simulate the full prize pool.
          </p>
          )}
        </div>
      </div>
      <footer className="relative z-[1] mt-8 text-[11px] tracking-wide text-muted/70">
        Powered by FanFunnel · provably-fair spins
      </footer>
    </main>
  );
}
