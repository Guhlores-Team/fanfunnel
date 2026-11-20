import "server-only";
import { deleteAccountAndTombstoneLinks, type AccountDeletionClient } from "./deleteAccount";

// DB-04 / OPS-06: the Privacy Policy deletes a declined access request AND the
// applicant's account DECLINED_ACCESS_REQUEST_DAYS after the decision. The
// nightly SQL cleanup (run_retention_cleanup, 0073) deletes the request and
// returns the applicants' profile ids once; removing the account (profile,
// Auth user, any stored objects) is this server step, through the same durable
// deletion job a self-close uses. Once the job is begun it survives a crash:
// the storage step and the paused-deletion retry of the same cron resume it.

/** At most this many accounts per run; the SQL side deletes requests in one pass. */
export const DECLINED_APPLICANT_BATCH = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DeclinedApplicantsOutcome = {
  /** Distinct account ids the cleanup returned. */
  due: number;
  /** Accounts fully deleted in this run. */
  completed: number;
  /** Deletions begun and left to the storage/retry steps. */
  pending: number;
  /** Not a declined creator applicant any more (approved since, an admin, an agency seat or owner, gone): left alone. */
  kept: number;
  /** Could not be begun, or the database refused; an admin must delete these by hand. */
  failed: number;
};

/**
 * Delete the accounts behind the declined requests the cleanup just removed.
 * An account is only touched while its profile still reads `creator` and
 * `rejected`: a later approval, or an admin, is never deleted by age. * An account
 * that holds an agency seat or owns an agency is somebody's staff or business,
 * not only an applicant, and is left for an admin as well.
 */
export async function deleteDeclinedApplicants(svc: AccountDeletionClient, raw: unknown): Promise<DeclinedApplicantsOutcome> {
  const all = Array.isArray(raw) ? [...new Set(raw.filter((id): id is string => typeof id === "string" && UUID.test(id)))] : [];
  const ids = all.slice(0, DECLINED_APPLICANT_BATCH);
  // Ids beyond the batch cannot be found again from the request table, so
  // they are reported as failed and alerted, never dropped silently.
  const out: DeclinedApplicantsOutcome = { due: all.length, completed: 0, pending: 0, kept: 0, failed: all.length - ids.length };
  if (ids.length === 0) return out;
  const found = await svc.from("profiles").select("id, role, approval_status").in("id", ids);
  if (found.error) return { ...out, failed: out.failed + ids.length };
  const profiles = new Map(((found.data ?? []) as { id: string; role: string; approval_status: string }[]).map((p) => [p.id, p]));
  // Fail closed: if the agency ties cannot be read, nobody is deleted in this run.
  const seats = await svc.from("org_members").select("profile_id").in("profile_id", ids);
  const owned = await svc.from("orgs").select("owner_id").in("owner_id", ids);
  if (seats.error || owned.error) return { ...out, failed: out.failed + ids.length };
  const tied = new Set([
    ...((seats.data ?? []) as { profile_id: string }[]).map((r) => r.profile_id),
    ...((owned.data ?? []) as { owner_id: string }[]).map((r) => r.owner_id),
  ]);
  for (const id of ids) {
    const profile = profiles.get(id);
    if (!profile || profile.role !== "creator" || profile.approval_status !== "rejected" || tied.has(id)) { out.kept++; continue; }
    let result: Awaited<ReturnType<typeof deleteAccountAndTombstoneLinks>>;
    try {
      // The SQL `begin` accepts a self-close only for the account itself; the
      // authorization here is the published retention period, not a person.
      result = await deleteAccountAndTombstoneLinks(svc, id, { wasAdmin: false, actorId: id, action: "account.self_close" });
    } catch { out.failed++; continue; }
    if ("ok" in result) out.completed++;
    else if ("pending" in result) out.pending++;
    else if (result.error === "not_found") out.kept++;
    else out.failed++;
  }
  return out;
}
