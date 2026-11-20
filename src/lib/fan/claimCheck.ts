// WF-17: the verdict of a claim-code check, shared by the verify page, its
// client form and /api/public/claim-check. Only the verdict ever travels in
// a URL (`?claimed=`), never the code.
export const CLAIM_CHECK_STATES = ["none", "match", "mismatch", "limited", "unavailable"] as const;
export type ClaimCheckState = (typeof CLAIM_CHECK_STATES)[number];

export function isClaimCheckState(value: unknown): value is ClaimCheckState {
  return typeof value === "string" && (CLAIM_CHECK_STATES as readonly string[]).includes(value);
}

/** The state a `?claimed=` query carries, or "none" for anything else. */
export function claimedState(raw: string | string[] | undefined): ClaimCheckState {
  return isClaimCheckState(raw) ? raw : "none";
}
