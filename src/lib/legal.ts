// The facts the Terms of Service and Privacy Policy depend on, in one place.
// Swap the operator for a registered legal entity here (and only here) once one
// exists; bump EFFECTIVE_DATE whenever either document's substance changes.

/**
 * An announced change to the Terms or Privacy Policy, shown on fan pages and
 * in the dashboard until it takes effect (TS-06). An admin announces it in
 * Admin › Terms change notice (public.legal_terms_notice, 0073) at least
 * LEGAL.changeNoticeDays before `effectiveDate`; on that date the new text
 * ships with `version`/`effectiveDate` moved to it. LEGAL.upcoming is the
 * same thing set in code, used when the database holds no notice.
 */
export interface LegalChangeNotice {
  /** The version the change will become (YYYY-MM-DD). */
  version: string;
  /** When it takes effect (YYYY-MM-DD, end of that day UTC). */
  effectiveDate: string;
  /** One plain sentence saying what changes (code-set notices only). */
  summary?: string;
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
  textHash: "3a8b21c1673ff372a48c6f3171ec6ac03a0f9087cc99a9491618d286468a569b",
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

export type LegalNoticeInputError = "invalid_version" | "version_not_later" | "invalid_date" | "date_in_past" | "too_soon";

/**
 * Whether an admin may announce `version` taking effect on `effectiveDate`:
 * both are real YYYY-MM-DD dates, the version is later than the one in force,
 * and the date is at least LEGAL.changeNoticeDays ahead of `today` (UTC),
 * unless `sooner` marks a change required by law or needed for security,
 * which the Terms allow to take effect earlier (never in the past).
 */
export function legalNoticeInputError(
  version: unknown,
  effectiveDate: unknown,
  opts: { sooner?: boolean; today?: Date } = {},
): LegalNoticeInputError | null {
  const isDate = (v: unknown): v is string =>
    typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
  const safe = (v: unknown) => {
    try {
      return isDate(v);
    } catch {
      return false;
    }
  };
  if (!safe(version)) return "invalid_version";
  if ((version as string) <= LEGAL.version) return "version_not_later";
  if (!safe(effectiveDate)) return "invalid_date";
  const today = (opts.today ?? new Date()).toISOString().slice(0, 10);
  if ((effectiveDate as string) < today) return "date_in_past";
  const days = Math.round((Date.parse(`${effectiveDate as string}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (!opts.sooner && days < LEGAL.changeNoticeDays) return "too_soon";
  return null;
}
