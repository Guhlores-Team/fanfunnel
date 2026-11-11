// C7: the optional reason an admin gives when rejecting an access request.
// A fixed list, so what is stored is a short code (kept in the admin activity
// log's details, which hold no free text or personal data) and what the
// applicant reads on /pending is written here. Pure: shared by the admin
// console, the route and the /pending page.
//
// A free-text reason needs its own column (0073 candidate:
// creator_applications.decision_reason text, check char_length <= 500).

export const REJECTION_REASONS = {
  incomplete: {
    label: "Details missing or unclear",
    applicant: "Some of the details were missing or unclear, so we couldn't review the request.",
  },
  unverified: {
    label: "Couldn't verify the links",
    applicant: "We couldn't confirm that the links you gave belong to you.",
  },
  not_a_fit: {
    label: "Not a fit for FanFunnel right now",
    applicant: "FanFunnel isn't open to this kind of account right now.",
  },
  duplicate: {
    label: "Already has an account",
    applicant: "It looks like you already have a FanFunnel account. Sign in with that one instead.",
  },
} as const;

export type RejectionReason = keyof typeof REJECTION_REASONS;

export function isRejectionReason(value: unknown): value is RejectionReason {
  return typeof value === "string" && Object.hasOwn(REJECTION_REASONS, value);
}

/** What the applicant reads for a stored code, or null for none/unknown. */
export function rejectionReasonText(value: unknown): string | null {
  return isRejectionReason(value) ? REJECTION_REASONS[value].applicant : null;
}
