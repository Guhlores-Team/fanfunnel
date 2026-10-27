// The facts the Terms of Service and Privacy Policy depend on, in one place.
// Swap the operator for a registered legal entity here (and only here) once one
// exists; bump EFFECTIVE_DATE whenever either document's substance changes.

export const LEGAL = {
  /** Who operates the service, as named in both documents. */
  operator: "FanFunnel",
  /** Product name used in running text. */
  product: "FanFunnel",
  /** Legal, privacy, copyright and data-rights requests all go here. */
  contactEmail: "support@easysimplesites.org",
  /** Governing law for the Terms. */
  governingLaw: "the Commonwealth of Massachusetts, USA",
  /** Where disputes are heard, unless mandatory consumer law says otherwise. */
  venue: "the state and federal courts located in Massachusetts",
  /** ISO date (YYYY-MM-DD) both documents took effect. */
  effectiveDate: "2026-10-27",
  /**
   * The Terms/Privacy version people agree to (YYYY-MM-DD). Recorded with every
   * acceptance (profiles.terms_version, fans.acked_terms_version); bumping it
   * asks every creator and fan to agree again. Bump it for material changes.
   */
  version: "2026-10-27",
  /** Advance notice before a material change to either document, or a creator fee, takes effect. */
  changeNoticeDays: 30,
  /** Minimum age for every user, creator or fan. */
  minimumAge: 18,
} as const;

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * "2026-10-27" -> "October 27, 2026". Parsed by hand, not with Date, so the
 * rendered date never shifts with the server's or viewer's time zone.
 */
export function formatLegalDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`formatLegalDate: expected YYYY-MM-DD, got ${iso}`);
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) throw new Error(`formatLegalDate: bad month in ${iso}`);
  return `${month} ${Number(m[3])}, ${m[1]}`;
}

/** Whether a stored acceptance is for the current Terms version. */
export function acceptedCurrentTerms(version: string | null | undefined): boolean {
  return version === LEGAL.version;
}

/**
 * A fan must (re)confirm the age/terms gate when they never have, or when the
 * version they agreed to is not the current one.
 */
export function fanNeedsAck(ackedAt: string | null | undefined, ackedVersion: string | null | undefined): boolean {
  return ackedAt == null || !acceptedCurrentTerms(ackedVersion);
}
