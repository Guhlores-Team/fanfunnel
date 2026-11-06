import assert from "node:assert/strict";
import { mock } from "node:test";
import { randomUUID } from "node:crypto";
import { FakeTables } from "@/lib/privacy/fakeTables";
import { FakeStorage } from "@/lib/privacy/fakeStorage";
import { FakeStorageWork } from "@/lib/storage/fakeWork";

const A = "aaaaaaaa-0000-4000-8000-00000000000a", B = "bbbbbbbb-0000-4000-8000-00000000000b";
let user: { id: string; user_metadata: Record<string, unknown> } | null = { id: A, user_metadata: { role: "admin", is_active: true } };
let isAdmin = false, aal = "aal2", services = 0;
const audits: Record<string, unknown>[] = [];
const users = new Set([A, B]);
const deleted: string[] = [];
const tables = new FakeTables({ profiles: [{ id: A, role: "creator", is_active: true, approval_status: "approved" }, { id: B, role: "creator", is_active: true, approval_status: "approved" }] });
const storage = new FakeStorage(); storage.add("avatars"); storage.add("creator-media");
const work = new FakeStorageWork(tables, { authExists: (id) => users.has(id), onAudit: (entry) => { audits.push(entry); } });
mock.module("@/lib/supabase/server", { namedExports: {
  isSupabaseConfigured: () => true,
  createClient: async () => ({ auth: {
    getUser: async () => ({ data: { user } }),
    getSession: async () => ({ data: { session: { access_token: `h.${Buffer.from(JSON.stringify({ aal })).toString("base64url")}.s` } } }),
  }, rpc: async () => ({ data: isAdmin, error: null }) }),
  createServiceClient: () => {
    services++;
    return { from: work.from, rpc: work.rpc, storage: storage.storage,
      auth: { admin: { deleteUser: async (id: string) => { users.delete(id); deleted.push(id); return { error: null }; } } } };
  },
} });
mock.module("@/lib/data", { namedExports: { recordAudit: async (entry: Record<string, unknown>) => { audits.push(entry); } } });

async function main() {
  const { POST } = await import("./route");
  const retry = (id: unknown) => POST(new Request("http://localhost/api/admin/account/storage-retry", { method: "POST", body: JSON.stringify({ id }) }));
  assert.equal((await retry(B)).status, 403, "metadata cannot authorize a creator");
  const signedIn = user; user = null;
  assert.equal((await retry(B)).status, 401);
  user = signedIn; isAdmin = true; aal = "aal1";
  assert.equal((await retry(B)).status, 403, "password-only admin cannot retry deletion");
  assert.equal(services, 0);
  aal = "aal2";
  assert.equal((await retry("../other")).status, 400);
  assert.equal((await retry(randomUUID())).status, 404, "retry cannot create a deletion for an arbitrary account");
  assert.equal(tables.rows("creator_storage_deletions").length, 0);

  tables.rows("profiles")[0].role = "admin";
  const intent = randomUUID(), path = `${B}/${randomUUID()}.webp`;
  await work.rpc("creator_storage_register_upload", { p_id: intent, p_owner: B, p_bucket: "avatars", p_path: path });
  await work.rpc("creator_storage_account", { p_operation: "begin", p_owner: B, p_actor: B, p_action: "account.self_close" });
  const pending = await retry(B);
  assert.equal(pending.status, 202);
  assert.equal((await pending.json()).pending, true);
  assert.equal(deleted.length, 0);
  assert.equal(audits.filter((entry) => entry.action === "account.storage_retry").length, 1);
  storage.add("avatars", path);
  const done = await retry(B);
  assert.equal(done.status, 200);
  assert.equal((await done.json()).ok, true);
  assert.deepEqual(deleted, [B]);
  assert.equal(audits.filter((entry) => entry.action === "account.self_close").length, 1);
  assert.equal(audits.filter((entry) => entry.action === "account.storage_retry").length, 2);
  const completed = await retry(B);
  assert.equal(completed.status, 200);
  assert.deepEqual(deleted, [B], "idempotent retry never deletes another account or repeats Auth deletion");
  assert.equal(audits.filter((entry) => entry.action === "account.self_close").length, 1);
  console.log("storage retry route: signed-out/creator/metadata/MFA/unknown-target negatives, pending status, scoped completion and idempotency passed");
}
main().catch((error) => { console.error(error); process.exit(1); });
