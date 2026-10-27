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
  /** In-app notices left for a creator, e.g. "a fan deleted their data". */
  creatorNotices: 90,
  /** Hashes of fan links that stopped working (account closed / fan deleted). */
  linkTombstones: 180,
  /** Error reports an admin marked resolved (app_errors, migration 0053). */
  resolvedAppErrors: 90,
  /** Agency invites that were declined or revoked (org_invites; they hold an
   *  email address). Pending and accepted invites are kept. */
  closedAgencyInvites: 90,
} as const;

export type RetentionKey = keyof typeof RETENTION_DAYS;

/** UTC time the Vercel Cron runs the cleanup (vercel.json must match). */
export const RETENTION_CRON_SCHEDULE = "17 4 * * *";
