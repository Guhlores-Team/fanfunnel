import type { ApprovalStatus } from "@/lib/data/admin";

/**
 * T7: who gets "Delete my request and account" on /pending. Only an applicant
 * whose request is waiting or was declined. An approved creator (or an admin,
 * which reads as approved) closes from Settings, where the owed-prize check
 * explains itself; anyone with no profile row gets nothing. The control only
 * calls POST /api/account/close, which re-checks the session, phrase,
 * password, two-factor and every refusal on the server.
 */
export function pendingSelfDeleteAllowed(status: ApprovalStatus | string | null | undefined): boolean {
  return status === "pending" || status === "rejected";
}
