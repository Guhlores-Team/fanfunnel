import "server-only";
import { randomUUID } from "node:crypto";
import { scanCreatorStorage } from "@/lib/storage/creatorObjects";
import { checkStorageFence, cleanupStorageObject, dispatchStorageEffect, storageRpc, STORAGE_REVIEW_AFTER_MS, type StorageObjectWork, type StorageWorkClient } from "@/lib/storage/work";

export type AccountDeletionClient = StorageWorkClient;
type Failure = "delete_failed" | "storage_cleanup_failed" | "db_error" | "last_admin" | "forbidden" | "not_found";
export type AccountDeletionResult =
  | { ok: true; links: number; auditRecorded: boolean }
  | { pending: true; reason: string; reviewRequired: boolean }
  | { error: Failure };
interface DeletionJob {
  owner_id: string;
  state: "pending" | "auth_deleting" | "auth_deleted" | "complete" | "paused";
  link_hashes: string[];
  created_at: string;
}

/** Every external effect is preceded by state that auth cascades cannot erase. */
export async function processAccountStorageDeletion(svc: AccountDeletionClient, userId: string): Promise<AccountDeletionResult> {
  const found = await svc.from("creator_storage_deletions").select("*").eq("owner_id", userId).maybeSingle();
  if (found.error) return { pending: true, reason: "db_error", reviewRequired: false };
  const job = found.data as DeletionJob | null;
  if (!job) return { error: "not_found" };
  if (job.state === "complete") return { ok: true, links: job.link_hashes.length, auditRecorded: true };
  if (job.state === "paused") return { error: "delete_failed" };
  const worker = randomUUID();
  const call = (operation: string, error?: string) => storageRpc(svc, "creator_storage_account", { p_operation: operation, p_owner: userId, p_worker: worker, ...(error ? { p_error: error } : {}) });
  const pending = async (reason: string, reviewRequired = false): Promise<AccountDeletionResult> => {
    await call("release", reason === "upload_unconfirmed" ? reason : reason === "storage_cleanup_failed" ? reason : "db_error");
    return { pending: true, reason, reviewRequired };
  };
  const pause = async (error: "delete_failed" | "storage_cleanup_failed" | "db_error"): Promise<AccountDeletionResult> => {
    const result = await call("pause", error);
    return !result.error && result.data?.state === "paused" ? { error } : pending(error);
  };
  const claimed = await call("claim");
  if (claimed.error || !claimed.data) return { pending: true, reason: "busy", reviewRequired: false };
  if (claimed.data.state === "complete") return { ok: true, links: Number(claimed.data.links) || 0, auditRecorded: true };
  const fence = { worker, attempt: String(claimed.data.attempt_id) };
  const authorized = () => checkStorageFence(svc, userId, fence);
  const cleanupRows = async (): Promise<AccountDeletionResult | null> => {
    const objects = await svc.from("creator_storage_objects").select("*").eq("owner_id", userId).is("removed_at", null).order("updated_at").limit(100);
    if (objects.error) return pause("db_error");
    let waiting = false, review = false;
    for (const object of (objects.data ?? []) as StorageObjectWork[]) {
      if (!(await authorized())) return pending("busy");
      // Rotate every examined item even if an observation stalls or is absent.
      const touched = await svc.from("creator_storage_objects").update({ last_attempt_at: new Date().toISOString(), attempts: object.attempts + 1, updated_at: new Date().toISOString() }).eq("id", object.id);
      if (touched.error) return pause("db_error");
      const result = await cleanupStorageObject(svc, object, fence);
      if (result === "failed") return pause("storage_cleanup_failed");
      if (result === "db_failed") return pause("db_error");
      if (result === "pending") { waiting = true; review ||= Date.now() - Date.parse(object.created_at) >= STORAGE_REVIEW_AFTER_MS; }
    }
    if (waiting) return pending("upload_unconfirmed", review);
    const remaining = await svc.from("creator_storage_objects").select("id").eq("owner_id", userId).is("removed_at", null).limit(1);
    if (remaining.error) return pause("db_error");
    return remaining.data?.length ? pending("batch_remaining") : null;
  };
  const initial = await cleanupRows();
  if (initial) return initial;
  let empty = false;
  for (let sweep = 0; sweep < 3; sweep++) {
    const discovered = await scanCreatorStorage(svc, userId, authorized);
    if (!discovered) return (await authorized()) ? pause("storage_cleanup_failed") : pending("busy");
    if (!discovered.some((entry) => entry.paths.length)) { empty = true; break; }
    for (const entry of discovered) for (let offset = 0; offset < entry.paths.length; offset += 100) {
      const paths = entry.paths.slice(offset, offset + 100);
      const manifest = await storageRpc(svc, "creator_storage_manifest", { p_owner: userId, p_attempt: fence.attempt, p_worker: worker, p_bucket: entry.bucket, p_paths: paths });
      if (manifest.error || manifest.data !== paths.length) return pending("busy");
    }
    const result = await cleanupRows();
    if (result) return result;
  }
  if (!empty) return pending("batch_remaining");
  if (claimed.data.state !== "auth_deleted") {
    const ready = await call("prepare");
    if (ready.error || ready.data?.state !== "auth_deleting") return pending("db_error");
    const outcome = await dispatchStorageEffect(svc, { owner: userId, kind: "auth", fence,
      effect: () => svc.auth.admin.deleteUser(userId) });
    // Checking auth.users recovers a commit whose acknowledgement was lost.
    const gone = await call("auth_deleted");
    if (gone.error) return pending("db_error");
    if (gone.data?.state !== "auth_deleted") return outcome === "rejected" ? pause("delete_failed") : pending("delete_failed");
  }
  const completed = await call("complete");
  if (completed.error || completed.data?.state !== "complete") return pending("db_error");
  return { ok: true, links: Number(completed.data.links) || 0, auditRecorded: true };
}

/** Password/MFA or active-admin authorization must precede this shared helper. */
export async function deleteAccountAndTombstoneLinks(svc: AccountDeletionClient, userId: string,
  options: { wasAdmin: boolean; actorId?: string; action?: "account.delete" | "account.self_close" },
): Promise<AccountDeletionResult> {
  const begun = await storageRpc(svc, "creator_storage_account", {
    p_operation: "begin", p_owner: userId, p_was_admin: options.wasAdmin,
    p_actor: options.actorId ?? userId, p_action: options.action ?? "account.self_close",
  });
  if (begun.error) return begun.definite ? { error: "db_error" } : { pending: true, reason: "db_error", reviewRequired: false };
  if (begun.data?.error) {
    const code = begun.data.error;
    return { error: code === "last_admin" ? code : code === "not_found" ? code : "forbidden" };
  }
  if (!begun.data) return { error: "db_error" };
  return processAccountStorageDeletion(svc, userId);
}
