// The facts the Terms of Service and Privacy Policy depend on, in one place.
// Swap the operator for a registered legal entity here (and only here) once one
// exists; bump EFFECTIVE_DATE whenever either document's substance changes.

/**
 * An announced change to the Terms or Privacy Policy, shown on fan pages and
 * in the dashboard until it takes effect (TS-06). Set it at least
 * LEGAL.changeNoticeDays before `effectiveDate`; on that date publish the new
 * text, move `version`/`effectiveDate` to it and set this back to null.
 */
export interface LegalChangeNotice {
  /** The version the change will become (YYYY-MM-DD). */
  version: string;
  /** When it takes effect (YYYY-MM-DD, end of that day UTC). */
  effectiveDate: string;
  /** One plain sentence saying what changes. */
  summary: string;
}

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
  effectiveDate: "2026-11-11",
  /**
   * The Terms/Privacy version people agree to (YYYY-MM-DD). Recorded with every
   * acceptance (profiles.terms_version, fans.acked_terms_version); bumping it
   * asks every creator and fan to agree again. Bump it for material changes.
   * The database reads the same value from public.legal_terms_version() (0072):
   * bump it there in a new migration too (legalTermsVersion.test.ts checks).
   */
  version: "2026-11-11",
  /**
   * SHA-256 of `version` + the source of terms/page.tsx + privacy/page.tsx.
   * Any edit to either page changes it; legalText.test.ts then fails and
   * prints the new value. Update it ONLY together with `version` and
   * `effectiveDate` (docs/LEGAL_NOTES.md, "Version discipline").
   */
  textHash: "5b6466715bbdce072aac58dc168e834858ef22d990af2d44f3940ad46b273ffa",
  /** The change announced for a coming version, or null when none is announced. */
  upcoming: null as LegalChangeNotice | null,
  /** Advance notice before a material change to either document, or a creator fee, takes effect. */
  changeNoticeDays: 30,
  /** Minimum age for every user, creator or fan. */
  minimumAge: 18,
  /**
   * TS-07: whether a reply sent by an agency or team seat is labelled for the
   * fan ("Team") in chat. Off until the owner decides; the Terms already say
   * replies may come from the creator or people they authorise.
   */
  teamReplyLabel: { enabled: false, label: "Team" },
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

/**
 * The announced change to show right now: LEGAL.upcoming while its effective
 * date (end of day, UTC) is still ahead and it is a later version than the
 * current one. Null otherwise, so a notice left in place after the date, or
 * one for the version already in force, never shows.
 */
export function activeLegalChangeNotice(now: Date = new Date(), notice: LegalChangeNotice | null = LEGAL.upcoming): LegalChangeNotice | null {
  if (!notice) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(notice.effectiveDate) || notice.version <= LEGAL.version) return null;
  const endOfDay = Date.parse(`${notice.effectiveDate}T23:59:59.999Z`);
  if (!Number.isFinite(endOfDay) || now.getTime() > endOfDay) return null;
  return notice;
}
