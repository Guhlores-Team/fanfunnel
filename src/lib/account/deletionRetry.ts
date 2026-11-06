import "server-only";
import { deleteAccountAndTombstoneLinks, type AccountDeletionClient } from "./deleteAccount";

// A18: an account deletion that reaches `paused` (storage cleanup or the Auth
// delete failed definitively) is no longer left for someone to notice. The
// daily maintenance cron resumes it with exponential backoff, using the actor
// and action that originally authorized it (the SQL `begin` re-checks both: a
// self-close only by its owner, an admin delete only while that admin is still
// an active admin). After DELETION_AUTO_RETRIES resumes it stops and waits for
// an admin, who sees every stuck deletion in Admin with a Retry button. An admin
// delete whose admin is no longer an active admin, or a resume the SQL refuses
// outright (last_admin, forbidden, not_found), is not retried automatically
// either: no backoff can fix it, so it waits for an admin's Retry at once.

export const DELETION_RETRY_BASE_MS = 15 * 60_000;
export const DELETION_RETRY_MAX_MS = 24 * 60 * 60_000;
/** Claims (`attempts`) after which the cron stops and leaves the job to an admin. */
export const DELETION_AUTO_RETRIES = 8;
/** A non-paused job untouched this long is shown as stuck too. */
export const DELETION_STALE_MS = 60 * 60_000;
export const DELETION_RETRY_BATCH = 10;

export type DeletionState = "pending" | "auth_deleting" | "auth_deleted" | "complete" | "paused";
export interface DeletionJobRow {
  owner_id: string;
  state: DeletionState;
  was_role: "admin" | "creator";
  actor_id: string | null;
  action: "account.delete" | "account.self_close";
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/** Wait before the next automatic resume: 15 min, 30 min, 1 h … capped at 24 h. */
export function deletionRetryDelayMs(attempts: number): number {
  const n = Math.max(0, Math.trunc(attempts) - 1);
  return Math.min(DELETION_RETRY_BASE_MS * 2 ** Math.min(n, 20), DELETION_RETRY_MAX_MS);
}

/** When the cron will next resume a paused job; null once it waits for an admin. */
export function nextDeletionRetryAt(job: Pick<DeletionJobRow, "state" | "attempts" | "updated_at">): string | null {
  if (job.state !== "paused" || job.attempts >= DELETION_AUTO_RETRIES) return null;
  const at = Date.parse(job.updated_at);
  return Number.isFinite(at) ? new Date(at + deletionRetryDelayMs(job.attempts)).toISOString() : null;
}

const JOB_COLUMNS = "owner_id, state, was_role, actor_id, action, attempts, last_error, created_at, updated_at";

/** Ids among `ids` that are active admins now, or null when that could not be read. */
async function activeAdmins(svc: AccountDeletionClient, ids: string[]): Promise<Set<string> | null> {
  if (ids.length === 0) return new Set();
  const found = await svc.from("profiles").select("id").in("id", ids).eq("role", "admin").eq("is_active", true);
  if (found.error) return null;
  return new Set(((found.data ?? []) as { id: string }[]).map((r) => r.id));
}

/** Whether the stored authorization can still pass the SQL `begin` re-check. */
function actorStillValid(job: DeletionJobRow, admins: Set<string> | null): boolean {
  if (job.action !== "account.delete") return true;
  if (!job.actor_id || job.actor_id === job.owner_id) return false;
  return admins === null || admins.has(job.actor_id);
}

export interface DeletionRetryStats { due: number; resumed: number; completed: number; pending: number; failed: number; waiting: number; needsAdmin: number }

const REFUSED = new Set(["last_admin", "forbidden", "not_found"]);
const adminActors = (jobs: DeletionJobRow[]) =>
  [...new Set(jobs.filter((j) => j.action === "account.delete" && j.actor_id).map((j) => j.actor_id as string))];

/** Resume every paused deletion whose backoff has elapsed (bounded per run). Never throws. */
export async function retryPausedDeletions(svc: AccountDeletionClient, now: number = Date.now()): Promise<DeletionRetryStats> {
  const stats: DeletionRetryStats = { due: 0, resumed: 0, completed: 0, pending: 0, failed: 0, waiting: 0, needsAdmin: 0 };
  try {
    const found = await svc.from("creator_storage_deletions").select(JOB_COLUMNS).eq("state", "paused").order("updated_at").limit(100);
    if (found.error) return { ...stats, failed: 1 };
    const jobs = (found.data ?? []) as DeletionJobRow[];
    const admins = await activeAdmins(svc, adminActors(jobs));
    if (admins === null) stats.failed++;
    for (const job of jobs) {
      const next = nextDeletionRetryAt(job);
      if (next === null) { stats.needsAdmin++; continue; }
      if (job.action === "account.delete") {
        // Unreadable admin list: resume nothing on an admin's authority this run
        // (counted failed once above); a demoted or missing admin: wait for one.
        if (admins === null) continue;
        if (!actorStillValid(job, admins)) { stats.needsAdmin++; continue; }
      }
      if (Date.parse(next) > now) { stats.waiting++; continue; }
      stats.due++;
      if (stats.resumed >= DELETION_RETRY_BATCH) continue;
      stats.resumed++;
      const result = await deleteAccountAndTombstoneLinks(svc, job.owner_id, {
        wasAdmin: job.was_role === "admin",
        actorId: job.actor_id ?? undefined,
        action: job.action,
      });
      if ("ok" in result) stats.completed++;
      else if ("pending" in result) stats.pending++;
      else if (REFUSED.has(result.error)) stats.needsAdmin++;
      else stats.failed++;
    }
  } catch {
    stats.failed++;
  }
  return stats;
}

export interface StuckDeletion {
  id: string;
  state: DeletionState;
  lastError: string | null;
  attempts: number;
  startedAt: string;
  updatedAt: string;
  /** Next automatic resume; null when only an admin retry will move it. */
  nextRetryAt: string | null;
}

/** Paused deletions, plus in-flight ones untouched for DELETION_STALE_MS. */
export async function listStuckDeletions(svc: AccountDeletionClient, now: number = Date.now()): Promise<StuckDeletion[] | null> {
  const stale = new Date(now - DELETION_STALE_MS).toISOString();
  const found = await svc.from("creator_storage_deletions").select(JOB_COLUMNS)
    .or(`state.eq.paused,and(state.in.(pending,auth_deleting,auth_deleted),updated_at.lt.${stale})`)
    .order("updated_at").limit(100);
  if (found.error) return null;
  const jobs = (found.data ?? []) as DeletionJobRow[];
  const admins = await activeAdmins(svc, adminActors(jobs.filter((j) => j.state === "paused")));
  return jobs.map((job) => ({
    id: job.owner_id,
    state: job.state,
    lastError: job.last_error,
    attempts: job.attempts,
    startedAt: job.created_at,
    updatedAt: job.updated_at,
    nextRetryAt: actorStillValid(job, admins) ? nextDeletionRetryAt(job) : null,
  }));
}
