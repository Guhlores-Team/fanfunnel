import { PUSH_LOG_RETENTION_DAYS } from "@/lib/push/config";

/**
 * Automatic data retention: how long each kind of operational record is kept
 * before the daily cleanup (GET /api/cron/retention → run_retention_cleanup,
 * migration 0054) deletes it. The ONE place these periods live; the Privacy
 * Policy cites docs/DATA_RETENTION.md, which must list the same numbers
 * (src/lib/privacy/retention.test.ts checks).
 *
 * Fans, spins, redemptions, grants and messages are business records the
 * creator controls; they are never deleted by age, only by an explicit delete
 * (creator deletes a fan, a fan deletes their data, an account is closed).
 */
export const RETENTION_DAYS = {
  /** Admin activity log entries (admin_audit_log). */
  adminAuditLog: 365,
  /** Web-push delivery deduplication history, removed by the daily job. */
  pushLog: PUSH_LOG_RETENTION_DAYS,
  /** In-app notices left for a creator, e.g. "a fan deleted their data". */
  creatorNotices: 90,
  /** Hashes of fan links that stopped working (account closed / fan deleted). */
  linkTombstones: 180,
  /** Error reports an admin marked resolved (app_errors, migration 0053). */
  resolvedAppErrors: 90,
  /** Agency invites that were declined, revoked or expired (org_invites; they hold an
   *  email address). Pending and accepted invites are kept. */
  closedAgencyInvites: 90,
  /** Fan visit check-ins (fan_checkins, 0050). The visit glow reads back
   *  CHECKIN_READ_DAYS (59); retention.test.ts keeps this above it. */
  fanCheckins: 90,
  /** Finished spin attempts (spin_attempts): the prepared context of a
   *  committed/declined attempt is cleared, and declined attempts (no spin, no
   *  debit) are deleted. Committed attempts keep their short record. */
  finishedSpinAttempts: 90,
  /** Settled creator request journals (creator_request_journal): idempotency
   *  records for grants/imports. The grants and fans they made stay. */
  settledRequestJournal: 90,
  /** Fan import batches and their per-row results (fan_import_batches,
   *  fan_import_items). A batch a pending request still uses is kept. */
  fanImportBatches: 90,
} as const;

export type RetentionKey = keyof typeof RETENTION_DAYS;

/**
 * T13 (COPY_FIXES 12): the Privacy Policy's period for a declined creator
 * access request. run_retention_cleanup (0073) deletes the request after
 * this many days (its `v_declined_application_days` mirrors it) and returns
 * the applicants, whose accounts the cron then deletes
 * (src/lib/account/declinedApplicants.ts). The applicant can delete the
 * request and account themselves from /pending at any time.
 */
export const DECLINED_ACCESS_REQUEST_DAYS = 90;

/** UTC time the Vercel Cron runs the cleanup (vercel.json must match). */
export const RETENTION_CRON_SCHEDULE = "17 4 * * *";
