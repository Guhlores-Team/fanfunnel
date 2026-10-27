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
