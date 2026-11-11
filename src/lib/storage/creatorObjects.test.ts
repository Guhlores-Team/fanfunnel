import assert from "node:assert/strict";
import { FakeStorage } from "@/lib/privacy/fakeStorage";
import { deleteCreatorStorage, removeCreatorObjects, type CreatorStorageClient } from "./creatorObjects";
import { StorageApiError } from "@supabase/storage-js";

const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const B = "bbbbbbbb-0000-4000-8000-00000000000b";
const client = (storage: FakeStorage) => storage as unknown as CreatorStorageClient;

async function main() {
  const storage = new FakeStorage();
  const avatars = Array.from({ length: 1005 }, (_, i) => `${A}/replaced-${String(i).padStart(4, "0")}.png`);
  storage.add("avatars", ...avatars, `${A}/old/nested/photo.png`, `${B}/keep.png`, `${A}-other/keep.png`);
  storage.add("creator-media", `${A}/hub.webp`, `${B}/keep.webp`);
  assert.deepEqual(await deleteCreatorStorage(client(storage), A), { ok: true });
  assert.equal(storage.objects.get("avatars")!.size, 2);
  assert.equal(storage.objects.get("creator-media")!.size, 1);
  assert.ok(storage.lists.some((call) => call.bucket === "avatars" && call.offset === 1000));
  assert.ok(storage.removals.every((call) => call.paths.length <= 1000 && call.paths.every((path) => path.startsWith(`${A}/`))));
  assert.equal(storage.removals.flatMap((call) => call.paths).length, 1007);
  assert.ok(storage.objects.get("avatars")!.has(`${B}/keep.png`));

  const before = storage.removals.length;
  for (const path of [`${B}/keep.png`, `${A}-other/keep.png`, `${A}/../${B}/keep.png`, `${A}/dir/../../keep.png`, `${A}/%2e%2e/keep.png`]) {
    assert.equal(await removeCreatorObjects(client(storage), "avatars", A, [path]), false);
  }
  for (const owner of ["", "../", `${A}/${B}`, `${A}/..`]) {
    assert.deepEqual(await deleteCreatorStorage(client(storage), owner), { error: "storage_cleanup_failed" });
  }
  assert.equal(storage.removals.length, before);

  const retry = new FakeStorage();
  retry.add("avatars", `${A}/retry.png`);
  retry.listFailures = 1;
  retry.removeFailures = 1;
  assert.deepEqual(await deleteCreatorStorage(client(retry), A), { ok: true });
  assert.equal(retry.removals.length, 2);
  assert.equal(retry.objects.get("avatars")!.size, 0);
  // A future bucket that is explicitly absent is empty, not a transport error.
  assert.ok(!retry.lists.some((call) => call.bucket === "creator-media"));

  const noSuchBucket = new StorageApiError("Bucket not found", 400, "NoSuchBucket");
  assert.equal(noSuchBucket.status, 400);
  assert.equal(noSuchBucket.statusCode, "NoSuchBucket");
  const absent = new FakeStorage();
  absent.add("avatars", `${A}/photo.png`);
  assert.deepEqual(await deleteCreatorStorage(client(absent), A), { ok: true });
  assert.ok(!absent.lists.some((call) => call.bucket === "creator-media"), "metadata establishes the future bucket is absent; its400 error is never guessed at");

  for (const failure of [noSuchBucket, new StorageApiError("Permission denied", 403, "AccessDenied"), new Error("network unavailable")]) {
    const denied = new FakeStorage();
    denied.add("avatars", `${A}/keep.png`);
    denied.metadataError = failure;
    assert.deepEqual(await deleteCreatorStorage(client(denied), A), { error: "storage_cleanup_failed" });
    assert.equal(denied.removals.length, 0, "metadata errors never authorize skipping a bucket");
  }
  const disappeared = new FakeStorage();
  disappeared.add("avatars", `${A}/keep.png`);
  disappeared.bucketIds = ["avatars", "creator-media"];
  assert.deepEqual(await deleteCreatorStorage(client(disappeared), A), { error: "storage_cleanup_failed" }, "a bucket that disappears after metadata listing fails closed on the actual400 NoSuchBucket shape");

  for (const failure of ["list", "remove", "throw", "unsafe"] as const) {
    const failed = new FakeStorage();
    failed.add("avatars", `${A}/retry.png`);
    if (failure === "list") failed.listFailures = 10;
    if (failure === "remove") failed.removeFailures = 10;
    if (failure === "throw") failed.throwOnRemove = true;
    if (failure === "unsafe") failed.injectName = `../${B}/keep.png`;
    assert.deepEqual(await deleteCreatorStorage(client(failed), A), { error: "storage_cleanup_failed" }, failure);
    assert.ok(failed.objects.get("avatars")!.has(`${A}/retry.png`));
    if (failure === "list" || failure === "unsafe") assert.equal(failed.removals.length, 0);
    else assert.equal(failed.removals.length, 3);
  }
  console.log("creator storage cleanup: pagination, nested/replaced objects, retries, failure and cross-creator negatives passed");
}
main().catch((error) => { console.error(error); process.exit(1); });
