import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { FakeTables } from "@/lib/privacy/fakeTables";
import { FakeStorage } from "@/lib/privacy/fakeStorage";
import { FakeStorageWork } from "./fakeWork";
import { processPendingStorageWork, queueMediaRemoval, processMediaRemoval, trackedCreatorUpload, type StorageWorkClient } from "./work";
import { deleteAccountAndTombstoneLinks, processAccountStorageDeletion } from "@/lib/account/deleteAccount";

const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const B = "bbbbbbbb-0000-4000-8000-00000000000b";
const C = "cccccccc-0000-4000-8000-00000000000c";
function fixture() {
  const tables = new FakeTables({ profiles: [A, B, C].map((id) => ({ id, role: id === C ? "admin" : "creator", is_active: true, approval_status: "approved" })), fan_passes: [{ creator_id: A, token: "fan-link-secret-never-store" }] });
  const storage = new FakeStorage();
  storage.add("avatars"); storage.add("creator-media");
  const users = new Set([A, B, C]);
  const deleted: string[] = [];
  const controls: { upload?: (path: string) => Promise<void>; auth: "ok" | "reject" | "ack_lost" } = { auth: "ok" };
  const work = new FakeStorageWork(tables, { authExists: (id) => users.has(id), admin: (id) => tables.rows("profiles").some((row) => row.id === id && row.role === "admin" && row.is_active) });
  const service = {
    rpc: work.rpc, from: work.from,
    storage: {
      listBuckets: storage.storage.listBuckets,
      from: (bucket: string) => ({ ...storage.storage.from(bucket), upload: async (path: string, _bytes: Uint8Array, options: { upsert: boolean }) => {
        assert.equal(options.upsert, false);
        assert.ok(tables.rows("creator_storage_objects").some((row) => row.path === path), "intent must commit before dispatch");
        await controls.upload?.(path);
        storage.add(bucket, path);
        return { error: null };
      } }),
    },
    auth: { admin: { deleteUser: async (id: string) => {
      if (controls.auth === "reject") return { error: { status: 400, message: "rejected" } };
      users.delete(id); deleted.push(id);
      tables.tables.profiles = tables.rows("profiles").filter((row) => row.id !== id);
      tables.tables.fan_passes = tables.rows("fan_passes").filter((row) => row.creator_id !== id);
      return { error: controls.auth === "ack_lost" ? new Error("transport lost after commit") : null };
    } } },
  } as unknown as StorageWorkClient;
  return { tables, storage, users, deleted, controls, work, service };
}
const path = (owner: string) => `${owner}/${randomUUID()}.webp`;
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("test operation did not finish")), 5000); })]); }
  finally { clearTimeout(timer); }
}
async function main() {
  {
    const f = fixture(), ownPath = path(A);
    const result = await trackedCreatorUpload(f.service, { owner: A, bucket: "avatars", path: ownPath, bytes: new Uint8Array([1]), contentType: "image/webp", authorize: async () => true });
    assert.ok("ok" in result);
    assert.ok(f.tables.rows("creator_storage_objects")[0].published_at);
    const before = f.work.calls.length;
    assert.deepEqual(await trackedCreatorUpload(f.service, { owner: A, bucket: "avatars", path: path(B), bytes: new Uint8Array([1]), contentType: "image/webp", authorize: async () => true }), { error: "forbidden" });
    assert.equal(f.work.calls.length, before, "cross-prefix attempt dispatches no work or bytes");
  }
  {
    const f = fixture(), ownPath = path(A), otherPath = path(B);
    f.storage.add("avatars", `${A}/replaced.png`, otherPath);
    let start!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { start = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.controls.upload = async () => { start(); await gate; };
    const uploading = trackedCreatorUpload(f.service, { owner: A, bucket: "avatars", path: ownPath, bytes: new Uint8Array([1]), contentType: "image/webp", authorize: async () => f.tables.rows("profiles").some((row) => row.id === A && row.is_active === true) });
    await within(started);
    const first = await deleteAccountAndTombstoneLinks(f.service, A, { wasAdmin: false });
    assert.ok("pending" in first && first.reason === "upload_unconfirmed");
    assert.equal(f.deleted.length, 0);
    assert.equal(f.tables.rows("profiles").find((row) => row.id === A)?.is_active, false);
    release();
    const late = await within(uploading);
    assert.deepEqual(late, { error: "forbidden" }, "late upload cannot publish after quiescence");
    assert.ok(!f.storage.objects.get("avatars")!.has(ownPath));
    const completed = await deleteAccountAndTombstoneLinks(f.service, A, { wasAdmin: false });
    assert.ok("ok" in completed);
    assert.deepEqual(f.deleted, [A]);
    assert.ok(f.storage.objects.get("avatars")!.has(otherPath));
    assert.ok(!JSON.stringify(f.tables.rows("creator_storage_deletions")).includes("fan-link-secret"));
    assert.equal(f.tables.rows("link_tombstones").length, 1);
    assert.equal(f.tables.rows("admin_audit_log").length, 1);
    assert.ok("ok" in (await processAccountStorageDeletion(f.service, A)));
    assert.equal(f.tables.rows("admin_audit_log").length, 1, "retry cannot duplicate completion audit");
  }
  {
    // A killed process after dispatch leaves its registered path. No timeout
    // can turn a missing object into proof the request cannot finish later.
    const f = fixture(), id = randomUUID(), ownPath = path(A);
    await f.work.rpc("creator_storage_register_upload", { p_id: id, p_owner: A, p_bucket: "avatars", p_path: ownPath });
    const row = f.tables.rows("creator_storage_objects")[0];
    row.created_at = new Date(Date.now() - 20 * 60_000).toISOString(); row.expires_at = row.created_at;
    const pending = await deleteAccountAndTombstoneLinks(f.service, A, { wasAdmin: false });
    assert.ok("pending" in pending && pending.reviewRequired);
    let stats = await processPendingStorageWork(f.service);
    assert.equal(stats.accountsPending, 1); assert.equal(stats.reviewRequired, 1); assert.equal(f.deleted.length, 0);
    assert.equal(f.tables.rows("creator_storage_objects").length, 1);
    f.storage.add("avatars", ownPath); // remote commit after the worker died
    stats = await processPendingStorageWork(f.service);
    assert.equal(stats.accountsCompleted, 1);
    assert.ok(!f.storage.objects.get("avatars")!.has(ownPath));
    assert.deepEqual(f.deleted, [A]);
  }
  {
    // A storage commit before a crashing/unreachable SQL finalizer remains
    // observable and tracked, so a later worker can settle and remove it.
    const f = fixture(), ownPath = path(A);
    f.work.failure = (name) => name === "creator_storage_finish_upload" ? new Error("database offline") : null;
    const result = await trackedCreatorUpload(f.service, { owner: A, bucket: "avatars", path: ownPath, bytes: new Uint8Array([1]), contentType: "image/webp", authorize: async () => true });
    assert.deepEqual(result, { error: "storage_cleanup_pending" });
    assert.ok(f.storage.objects.get("avatars")!.has(ownPath), "committed object is retained as settlement evidence");
    const row = f.tables.rows("creator_storage_objects")[0]; row.expires_at = new Date(Date.now() - 1).toISOString();
    f.work.failure = null;
    const stats = await processPendingStorageWork(f.service);
    assert.equal(stats.completed, 1);
    assert.ok(!f.storage.objects.get("avatars")!.has(ownPath));
    assert.ok(f.users.has(A));
  }
  {
    const f = fixture(); f.controls.auth = "ack_lost";
    const result = await deleteAccountAndTombstoneLinks(f.service, A, { wasAdmin: false });
    assert.ok("ok" in result, "SQL recovers an auth deletion whose acknowledgement was lost");
    assert.equal(f.tables.rows("creator_storage_deletions")[0].state, "complete");
    assert.equal(f.tables.rows("admin_audit_log").length, 1);
  }
  {
    const f = fixture();
    f.work.failure = (_name, args) => args.p_operation === "complete" ? new Error("worker died before bookkeeping") : null;
    const result = await deleteAccountAndTombstoneLinks(f.service, A, { wasAdmin: false });
    assert.ok("pending" in result);
    assert.ok(!f.users.has(A));
    assert.equal(f.tables.rows("creator_storage_deletions")[0].state, "auth_deleted");
    f.work.failure = null;
    assert.ok("ok" in (await processAccountStorageDeletion(f.service, A)));
    assert.equal(f.tables.rows("admin_audit_log").length, 1);
    assert.equal(f.tables.rows("link_tombstones").length, 1);
  }
  {
    const f = fixture(), mediaId = randomUUID(), ownPath = path(A);
    f.tables.rows("creator_media").push({ id: mediaId, creator_id: A, path: ownPath });
    f.storage.add("creator-media", ownPath);
    assert.equal(await queueMediaRemoval(f.service, A, [{ id: mediaId, path: ownPath }], C, true), true);
    f.storage.removeFailures = 3;
    assert.deepEqual(await processMediaRemoval(f.service, A, [ownPath]), { error: "storage_cleanup_failed" });
    assert.equal(f.tables.rows("creator_media").length, 1);
    assert.equal(f.tables.rows("admin_audit_log").length, 0);
    f.storage.removeFailures = 0;
    assert.equal((await processPendingStorageWork(f.service)).completed, 1);
    assert.equal(f.tables.rows("creator_media").length, 0);
    assert.equal(f.tables.rows("admin_audit_log").length, 1);
    await processPendingStorageWork(f.service);
    assert.equal(f.tables.rows("admin_audit_log").length, 1);
  }
  {
    const f = fixture();
    f.work.failure = (name) => name === "creator_storage_prune" ? new Error("retention unavailable") : null;
    assert.equal((await processPendingStorageWork(f.service)).failed, 1, "failed ledger pruning is reported to the authenticated retention caller");
  }
  console.log("durable storage: pre-dispatch intent, quiescence, late/crashed writes, unconfirmed review, lost auth/SQL acknowledgements, cross-user isolation and idempotent retries passed");
}
main().catch((error) => { console.error(error); process.exit(1); });
