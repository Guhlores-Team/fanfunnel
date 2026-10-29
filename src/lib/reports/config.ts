// Fan → FanFunnel safety reports: every tunable in one place. Isomorphic (no
// server imports) so the fan Safety menu and the admin view share the list.
import { PHOTO_REPORT_REASON } from "@/lib/creatorTheme/config";

/** Reported content that may involve someone under 18. Always urgent. */
export const CHILD_SAFETY_REPORT_REASON = "Involves someone under 18";
export const ILLEGAL_REPORT_REASON = "Illegal content or activity";

/** The reasons a fan can pick, in menu order. */
export const REPORT_REASONS = [
  "Predatory / pressuring behaviour",
  "Not delivering won prizes",
  "Harassment or abuse",
  CHILD_SAFETY_REPORT_REASON,
  ILLEGAL_REPORT_REASON,
  PHOTO_REPORT_REASON,
  "Other",
] as const;

/**
 * Reasons that e-mail ALERT_EMAIL_TO the moment they arrive (child safety,
 * illegal content, an inappropriate public photo). Listed first in Admin.
 */
export const URGENT_REPORT_REASONS: readonly string[] = [
  CHILD_SAFETY_REPORT_REASON,
  ILLEGAL_REPORT_REASON,
  PHOTO_REPORT_REASON,
];

export function isUrgentReportReason(reason: string): boolean {
  return URGENT_REPORT_REASONS.includes(reason);
}

/** Urgent-report alert e-mails per rolling hour, across instances when Upstash is set. */
export const REPORT_ALERTS_PER_HOUR = 10;

/** Longest admin resolution note (the 0064 CHECK matches). */
export const REPORT_NOTE_MAX = 1000;

/** Reports per page in Admin › Reports. */
export const REPORTS_PAGE_SIZE = 50;

export type ReportStatus = "open" | "resolved" | "dismissed";
export const REPORT_STATUSES: readonly ReportStatus[] = ["open", "resolved", "dismissed"];
