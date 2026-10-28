import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isCreatorObjectPath, observeCreatorObject, type CreatorBucket } from "./creatorObjects";

export type StorageWorkClient = Pick<SupabaseClient, "storage" | "rpc" | "from" | "auth">;
export interface StorageObjectWork {
  id: string;
  owner_id: string;
  bucket: CreatorBucket;
  path: string;
  upload_state: "inflight" | "stored" | "rejected" | "uncertain";
  cleanup_kind: "none" | "orphan" | "media" | "account";
  media_id: string | null;
  removed_at: string | null;
  published_at: string | null;
  expires_at: string;
  created_at: string;
  attempts: number;
  deletion_attempt?: string | null;
  next_attempt_at?: string;
  last_attempt_at?: string | null;
}
export const STORAGE_WORK_LIMIT = 20;
export const STORAGE_REVIEW_AFTER_MS = 15 * 60_000;
export const COMPLETED_STORAGE_WORK_DAYS = 30;

/** Only idempotent mutations use this retry helper. Registration is not replayed. */
export async function storageRpc(svc: StorageWorkClient, name: string, args: Record<string, unknown>) {
  let code: string | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await svc.rpc(name, args);
      if (!result.error) return { data: result.data, error: null };
      code = /^[0-9A-Z]{5}$/.test(result.error.code ?? "") ? result.error.code : undefined;
    } catch { code = undefined; /* transport failure is not completion */ }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
  }
  return { data: null, error: "db_error" as const, definite: !!code, code };
}

async function settle(svc: StorageWorkClient, id: string, outcome: string) {
  return storageRpc(svc, "creator_storage_finish_upload", { p_id: id, p_outcome: outcome });
}

export interface StorageFence { attempt: string; worker: string; }
export async function checkStorageFence(svc: StorageWorkClient, owner: string, fence: StorageFence): Promise<boolean> {
  const result = await storageRpc(svc, "creator_storage_account", { p_operation: "check", p_owner: owner, p_worker: fence.worker });
  return !result.error && result.data?.attempt_id === fence.attempt;
}

/** Register once before the call. No stale worker can authorize a new call;
 * an already-dispatched call remains durable and blocks account restoration. */
export async function dispatchStorageEffect(svc: StorageWorkClient, input: {
  owner: string; kind: "remove" | "auth"; object?: string; fence?: StorageFence; originUpload?: boolean;
  effect: () => PromiseLike<{ error: unknown }>;
}): Promise<"acknowledged" | "rejected" | "uncertain" | "pending" | "db_failed"> {
  const id = randomUUID();
  try {
    const begin = await svc.rpc("creator_storage_dispatch", { p_operation: "begin", p_id: id, p_owner: input.owner,
      p_origin_upload: input.originUpload ?? false, p_kind: input.kind, p_object: input.object ?? null, p_attempt: input.fence?.attempt ?? null, p_worker: input.fence?.worker ?? null });
    if (begin.error || begin.data?.dispatch !== true) {
      // This invocation sent no external request, even if SQL committed and its
      // registration acknowledgement was lost.
      await storageRpc(svc, "creator_storage_dispatch", { p_operation: "finish", p_id: id, p_owner: input.owner, p_outcome: "rejected" });
      return begin.error ? "db_failed" : "pending";
    }
  } catch {
    await storageRpc(svc, "creator_storage_dispatch", { p_operation: "finish", p_id: id, p_owner: input.owner, p_outcome: "rejected" });
    return "db_failed";
  }
  let error: unknown;
  try { error = (await input.effect()).error; } catch (caught) { error = caught; }
  const status = error && typeof error === "object" ? Number((error as { status?: unknown }).status) : NaN;
  const outcome = !error ? "acknowledged" : status >= 400 && status < 500 && status !== 408 ? "rejected" : "uncertain";
  const finished = await storageRpc(svc, "creator_storage_dispatch", { p_operation: "finish", p_id: id, p_owner: input.owner, p_outcome: outcome });
  return finished.error || finished.data?.state !== outcome ? "db_failed" : outcome;
}

export async function cleanupStorageObject(svc: StorageWorkClient, row: StorageObjectWork, fence?: StorageFence, originUpload = false): Promise<"complete" | "pending" | "failed" | "db_failed"> {
  if (!isCreatorObjectPath(row.owner_id, row.path)) return "failed";
  if (row.removed_at) return "complete";
  const authorize = fence ? () => checkStorageFence(svc, row.owner_id, fence) : undefined;
  if (authorize && !(await authorize())) return "pending";
  if (row.upload_state === "inflight" || row.upload_state === "uncertain") {
    const observed = await observeCreatorObject(svc, row.bucket, row.owner_id, row.path, authorize);
    if (observed === "error") return authorize && !(await authorize()) ? "pending" : "failed";
    if (observed !== "present") return "pending";
    if ((await settle(svc, row.id, "stored")).error) return "db_failed";
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await dispatchStorageEffect(svc, { owner: row.owner_id, kind: "remove", object: row.id, fence, originUpload,
      effect: () => svc.storage.from(row.bucket).remove([row.path]) });
    if (result === "acknowledged") return "complete";
    if (result === "pending" || result === "db_failed") return result;
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
  }
  if ((await observeCreatorObject(svc, row.bucket, row.owner_id, row.path, authorize)) === "bucket_absent") {
    const done = await storageRpc(svc, "creator_storage_complete_remove", { p_id: row.id });
    return !done.error && done.data === true ? "complete" : "db_failed";
  }
  return "failed";
}

export async function abandonStorageUpload(svc: StorageWorkClient, id: string): Promise<boolean> {
  if ((await settle(svc, id, "cleanup")).error) return false;
  const row = await svc.from("creator_storage_objects").select("*").eq("id", id).maybeSingle();
  return !row.error && !!row.data && (await cleanupStorageObject(svc, row.data as StorageObjectWork, undefined, true)) === "complete";
}

export type TrackedUploadResult = { ok: true; id: string; path: string } | {
  error: "forbidden" | "upload_failed" | "storage_cleanup_failed" | "storage_cleanup_pending" | "db_error";
};

/** Register first, send bytes once with upsert:false, and publish only after SQL authorization. */
export async function trackedCreatorUpload(svc: StorageWorkClient, input: {
  owner: string; bucket: CreatorBucket; path: string; bytes: Uint8Array;
  contentType: string; cacheControl?: string; publish?: boolean; authorize: () => Promise<boolean>;
}): Promise<TrackedUploadResult> {
  if (!isCreatorObjectPath(input.owner, input.path)) return { error: "forbidden" };
  const id = randomUUID();
  try {
    const registered = await svc.rpc("creator_storage_register_upload", { p_id: id, p_owner: input.owner, p_bucket: input.bucket, p_path: input.path });
    if (registered.error || registered.data?.registered !== true) {
      // No upload was dispatched by this invocation. An acknowledgement-lost
      // registration can therefore be safely settled as rejected.
      await settle(svc, id, "rejected");
      return { error: registered.error?.code === "42501" ? "forbidden" : "db_error" };
    }
  } catch {
    await settle(svc, id, "rejected");
    return { error: "db_error" };
  }
  let error: unknown;
  try {
    error = (await svc.storage.from(input.bucket).upload(input.path, input.bytes, {
      contentType: input.contentType, cacheControl: input.cacheControl, upsert: false,
    })).error;
  } catch (caught) { error = caught; }
  if (error) {
    const status = typeof error === "object" ? Number((error as { status?: unknown }).status) : NaN;
    const outcome = status >= 400 && status < 500 && status !== 408 ? "rejected" : "uncertain";
    const finished = await settle(svc, id, outcome);
    if (!finished.error && outcome === "rejected") await abandonStorageUpload(svc, id);
    return { error: outcome === "uncertain" || finished.error ? "storage_cleanup_pending" : "upload_failed" };
  }
  // Preserve committed bytes as reconciliation evidence if recording the
  // definitive upload result fails; do not remove them and lose that proof.
  if ((await settle(svc, id, "stored")).error) return { error: "storage_cleanup_pending" };
  let authorized = false;
  try { authorized = await input.authorize(); } catch { /* fail closed */ }
  if (!authorized) return { error: await abandonStorageUpload(svc, id) ? "forbidden" : "storage_cleanup_failed" };
  if (input.publish === false) return { ok: true, id, path: input.path };
  const publish = await settle(svc, id, "publish");
  if (publish.error) return { error: "storage_cleanup_pending" };
  if (publish.data !== true) return { error: await abandonStorageUpload(svc, id) ? "forbidden" : "storage_cleanup_failed" };
  return { ok: true, id, path: input.path };
}

/** Queue every row before touching storage; the SQL transaction retains paths on failure. */
export async function queueMediaRemoval(svc: StorageWorkClient, owner: string,
  rows: { id: string; path: string }[], actor: string, admin = false): Promise<boolean> {
  if (!rows.length || !rows.every((row) => isCreatorObjectPath(owner, row.path))) return false;
  const queued = await storageRpc(svc, "creator_storage_queue_remove", { p_owner: owner, p_objects: rows, p_actor: actor, p_admin: admin });
  return !queued.error && queued.data === rows.length;
}

export async function processMediaRemoval(svc: StorageWorkClient, owner: string, paths: string[]): Promise<{ ok: true } | { error: "db_error" | "storage_cleanup_failed" }> {
  const found = await svc.from("creator_storage_objects").select("*").eq("owner_id", owner).in("path", paths);
  if (found.error || found.data?.length !== new Set(paths).size) return { error: "db_error" };
  for (const row of found.data as StorageObjectWork[]) {
    const result = await cleanupStorageObject(svc, row);
    if (result !== "complete") return { error: result === "db_failed" ? "db_error" : "storage_cleanup_failed" };
  }
  return { ok: true };
}

/** Bounded maintenance, reachable only through authenticated server entry points. */
export async function processPendingStorageWork(svc: StorageWorkClient, limit = STORAGE_WORK_LIMIT) {
  const n = Math.min(Math.max(Math.trunc(limit) || 1, 1), STORAGE_WORK_LIMIT);
  const stats = { completed: 0, pending: 0, failed: 0, reviewRequired: 0, accountsCompleted: 0, accountsPending: 0 };
  // A claim advances scheduling; never replay it after a lost acknowledgement.
  const claimed = await svc.rpc("creator_storage_work_claim", { p_limit: n }).then((result) => result, () => ({ data: null, error: true }));
  if (claimed.error || !Array.isArray(claimed.data)) return { ...stats, failed: 1 };
  const unique = claimed.data as StorageObjectWork[];
  for (const row of unique) {
    if (row.cleanup_kind === "none" && (await settle(svc, row.id, "cleanup")).error) { stats.failed++; continue; }
    const result = await cleanupStorageObject(svc, row);
    if (result === "complete") stats.completed++;
    else if (result === "failed" || result === "db_failed") stats.failed++;
    else { stats.pending++; if (Date.now() - Date.parse(row.created_at) >= STORAGE_REVIEW_AFTER_MS) stats.reviewRequired++; }
  }
  // Backoff defers work; it must not make unresolved cleanup look complete.
  const deferred = await svc.from("creator_storage_objects").select("created_at").neq("cleanup_kind", "none").neq("cleanup_kind", "account").is("removed_at", null).order("created_at").limit(1);
  const unpublished = await svc.from("creator_storage_objects").select("created_at").eq("cleanup_kind", "none").is("published_at", null).is("removed_at", null).lt("expires_at", new Date().toISOString()).order("created_at").limit(1);
  if (deferred.error || unpublished.error) stats.failed++;
  if (!stats.pending && ((deferred.data?.length ?? 0) + (unpublished.data?.length ?? 0) > 0)) stats.pending = 1;
  const jobs = await svc.from("creator_storage_deletions").select("owner_id").in("state", ["pending", "auth_deleting", "auth_deleted"]).order("updated_at").limit(n);
  if (jobs.error) { stats.failed++; return stats; }
  const { processAccountStorageDeletion } = await import("@/lib/account/deleteAccount");
  for (const job of jobs.data ?? []) {
    const result = await processAccountStorageDeletion(svc, job.owner_id);
    if ("ok" in result) stats.accountsCompleted++;
    else if ("pending" in result) { stats.accountsPending++; if (result.reviewRequired) stats.reviewRequired++; }
    else stats.failed++;
  }
  if ((await storageRpc(svc, "creator_storage_prune", { p_days: COMPLETED_STORAGE_WORK_DAYS })).error) stats.failed++;
  return stats;
}
