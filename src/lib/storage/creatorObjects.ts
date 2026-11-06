import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export type CreatorStorageClient = Pick<SupabaseClient, "storage">;
export type CreatorBucket = "avatars" | "creator-media";
// Conservative documented page size; do not infer absence from an oversized
// request silently capped by an older Storage server.
const PAGE = 100;
const MAX_OBJECTS = 100_000;
const MAX_FOLDERS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const segment = (value: string) => value !== "." && value !== ".." && /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(value);

/** A path is always scoped to the server-selected owner's exact directory. */
export function isCreatorObjectPath(userId: string, path: string): boolean {
  return UUID.test(userId) && path.startsWith(`${userId}/`) && path.split("/").every(segment);
}

type StorageResult = { error: unknown };
export type StorageAuthority = () => Promise<boolean>;
async function retry<T extends StorageResult>(operation: () => PromiseLike<T>, authorize?: StorageAuthority): Promise<T | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (authorize && !(await authorize())) return null;
      const result = await operation();
      if (authorize && !(await authorize())) return null;
      if (!result.error) return result;
    } catch {
      // A transport failure is retried just like a storage API failure.
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
  }
  return null;
}

/** Remove objects first; callers must retain DB references if this fails. */
export async function removeCreatorObjects(
  svc: CreatorStorageClient,
  bucket: CreatorBucket,
  userId: string,
  paths: string[],
): Promise<boolean> {
  if (!UUID.test(userId) || !paths.every((path) => isCreatorObjectPath(userId, path))) return false;
  const unique = [...new Set(paths)];
  for (let from = 0; from < unique.length; from += PAGE) {
    if (!(await retry(() => svc.storage.from(bucket).remove(unique.slice(from, from + PAGE))))) return false;
  }
  return true;
}

async function listBuckets(svc: CreatorStorageClient, authorize?: StorageAuthority): Promise<Set<string> | null> {
  const buckets = new Set<string>();
  for (let offset = 0; offset < MAX_FOLDERS; offset += PAGE) {
    const result = await retry(() => svc.storage.listBuckets({ limit: PAGE, offset, sortColumn: "id", sortOrder: "asc" }), authorize);
    if (!result || !Array.isArray(result.data)) return null;
    for (const bucket of result.data) {
      if (typeof bucket.id !== "string" || !bucket.id) return null;
      buckets.add(bucket.id);
    }
    if (result.data.length < PAGE) return buckets;
  }
  return null;
}

/** Observe one immutable intent path without guessing what HTTP errors mean. */
export async function observeCreatorObject(
  svc: CreatorStorageClient, bucket: CreatorBucket, owner: string, path: string, authorize?: StorageAuthority,
): Promise<"present" | "absent" | "bucket_absent" | "error"> {
  if (!isCreatorObjectPath(owner, path)) return "error";
  const buckets = await listBuckets(svc, authorize);
  if (!buckets) return "error";
  if (!buckets.has(bucket)) return "bucket_absent";
  const slash = path.lastIndexOf("/");
  const folder = path.slice(0, slash), name = path.slice(slash + 1);
  for (let offset = 0; offset < MAX_OBJECTS; offset += PAGE) {
    const result = await retry(() => svc.storage.from(bucket).list(folder, { limit: PAGE, offset, search: name, sortBy: { column: "name", order: "asc" } }), authorize);
    if (!result || !Array.isArray(result.data)) return "error";
    if (result.data.some((object) => object.name === name && typeof object.id === "string")) return "present";
    if (result.data.length < PAGE) return "absent";
  }
  return "error";
}

/** Collect before removing: deleting while paging by offset would skip objects. */
async function listCreatorObjects(svc: CreatorStorageClient, bucket: CreatorBucket, userId: string, authorize?: StorageAuthority): Promise<string[] | null> {
  const folders = [userId];
  const paths: string[] = [];
  for (let next = 0; next < folders.length; next++) {
    const folder = folders[next];
    for (let offset = 0; ; offset += PAGE) {
      const result = await retry(() => svc.storage.from(bucket).list(folder, {
        limit: PAGE, offset, sortBy: { column: "name", order: "asc" },
      }), authorize);
      if (!result || !Array.isArray(result.data)) return null;
      for (const object of result.data) {
        if (typeof object.name !== "string" || !segment(object.name)) return null;
        const path = `${folder}/${object.name}`;
        if (!isCreatorObjectPath(userId, path) || path.split("/").length > 20) return null;
        if (object.id === null) folders.push(path);
        else if (typeof object.id === "string" && object.id.length > 0) paths.push(path);
        else return null;
        if (paths.length > MAX_OBJECTS || folders.length > MAX_FOLDERS) return null;
      }
      if (result.data.length < PAGE) break;
    }
  }
  return paths;
}

/** Read-only discovery; a stale response never directly authorizes removal. */
export async function scanCreatorStorage(svc: CreatorStorageClient, userId: string, authorize: StorageAuthority): Promise<{ bucket: CreatorBucket; paths: string[] }[] | null> {
  if (!UUID.test(userId)) return null;
  const buckets = await listBuckets(svc, authorize);
  if (!buckets) return null;
  const result: { bucket: CreatorBucket; paths: string[] }[] = [];
  for (const bucket of ["avatars", "creator-media"] as const) {
    if (!buckets.has(bucket)) continue;
    const paths = await listCreatorObjects(svc, bucket, userId, authorize);
    if (!paths) return null;
    result.push({ bucket, paths });
  }
  return result;
}

/**
 * Sweep every stored object, including replaced/unreferenced photos, before
 * auth/DB deletion loses the account's retry path. Bounded repeat sweeps catch
 * partial responses or writes that completed during the first listing.
 */
export async function deleteCreatorStorage(
  svc: CreatorStorageClient,
  userId: string,
): Promise<{ ok: true } | { error: "storage_cleanup_failed" }> {
  if (!UUID.test(userId)) return { error: "storage_cleanup_failed" };
  // Storage versions return different HTTP statuses for a missing bucket.
  // A successful authenticated metadata listing establishes absence without
  // interpreting an error as permission to skip cleanup.
  const buckets = await listBuckets(svc);
  if (!buckets) return { error: "storage_cleanup_failed" };
  for (const bucket of ["avatars", "creator-media"] as const) {
    if (!buckets.has(bucket)) continue;
    let empty = false;
    for (let sweep = 0; sweep < 3; sweep++) {
      const paths = await listCreatorObjects(svc, bucket, userId);
      if (!paths) return { error: "storage_cleanup_failed" };
      if (paths.length === 0) { empty = true; break; }
      if (!(await removeCreatorObjects(svc, bucket, userId, paths))) return { error: "storage_cleanup_failed" };
    }
    if (!empty) return { error: "storage_cleanup_failed" };
  }
  return { ok: true };
}
