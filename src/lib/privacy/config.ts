/**
 * Privacy & safety decisions, each behind one named constant so the owner can
 * flip it in one place. Imported by both server routes and client UI, so no
 * server-only imports here.
 */

/**
 * Admins must use two-factor (TOTP) for every admin page and /api/admin route.
 * The database enforces the same rule in is_admin() (migration 0054); turning
 * it off also needs a migration that drops the aal2 clause from is_admin().
 */
export const ADMIN_MFA_REQUIRED = true;

/** The phrase a creator types to close their account (plus their password). */
export const CLOSE_ACCOUNT_PHRASE = "DELETE MY ACCOUNT";

/** The word a fan types to confirm deleting their data. */
export const FAN_DELETE_PHRASE = "DELETE";

/**
 * Rate limits, as [max requests, window in ms]. The fan token is the only
 * credential on the fan side, so each fan action is limited per token AND per
 * client IP (a guessing run across tokens still hits the IP bucket).
 */
export const LIMITS = {
  fanExportPerToken: [5, 60 * 60 * 1000],
  fanExportPerIp: [20, 60 * 60 * 1000],
  fanDeletePerToken: [3, 60 * 60 * 1000],
  fanDeletePerIp: [10, 60 * 60 * 1000],
  creatorExport: [5, 60 * 60 * 1000],
  closeAccount: [5, 60 * 60 * 1000],
  mfaUnenroll: [10, 60 * 60 * 1000],
} as const satisfies Record<string, readonly [number, number]>;

/**
 * The fan export masks the fan's OTHER link tokens to their last 4 characters,
 * so one leaked link can't be turned into every link the fan holds.
 */
export const FAN_EXPORT_TOKEN_TAIL = 4;
