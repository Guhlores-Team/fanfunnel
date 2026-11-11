import type { SeedCommitment } from "@/lib/data/types";

/**
 * What a matching hash proves depends on HOW the spin got its seed. Only a
 * `published` commitment carries the full "fixed before you spun" guarantee;
 * every other case says so instead of borrowing that claim.
 *
 * `stored` is NOT strong: the concurrent winner generated that seed during its
 * own request, while this spin's request (client seed included) was already on
 * the server — so a dishonest server could have picked it knowing this spin's
 * input, and the fan never saw its hash in advance.
 */
export const COMMITMENT_COPY: Record<
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
    label: "Committed while your spin was in flight",
    verdict:
      "Two spins were in flight on this link. This seed was committed on the server while your spin was in flight; its hash was not shown to you in advance, so this check alone doesn't prove the outcome was fixed before your spin.",
    strong: false,
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

export const VERDICT_GREEN = "#22c55e";
export const VERDICT_AMBER = "#f59e0b";
export const VERDICT_RED = "#ef4444";

/**
 * Green only when the hash matches AND the commitment was fixed in advance; a
 * consistent-but-unpublished pair is amber; a mismatch is red.
 */
export function verdictColor(hashOk: boolean, commitment: SeedCommitment | null | undefined): string {
  if (!hashOk) return VERDICT_RED;
  return COMMITMENT_COPY[commitment ?? "unknown"].strong ? VERDICT_GREEN : VERDICT_AMBER;
}
