import assert from "node:assert/strict";
import { mock } from "node:test";
import { FakeTables } from "@/lib/privacy/fakeTables";
import { FakeStorage } from "@/lib/privacy/fakeStorage";
import { FakeStorageWork } from "@/lib/storage/fakeWork";

const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const B = "bbbbbbbb-0000-4000-8000-00000000000b";
let user: { id: string; user_metadata: Record<string, unknown> } | null = { id: A, user_metadata: { role: "admin", is_active: true } };
let isAdmin = false;
let aal = "aal2";
let services = 0;
const deleted: string[] = [];
const audits: Record<string, unknown>[] = [];
const tables = new FakeTables({
  profiles: [{ id: B, email: "target@example.test", role: "admin", is_active: true }, { id: A, role: "admin", is_active: true }],
  fan_passes: [{ id: "one", creator_id: B, token: "target-link-123" }],
  link_tombstones: [],
});
const storage = new FakeStorage();
storage.add("avatars", `${B}/old.png`, `${B}/current.png`, `${A}/keep.png`);
storage.add("creator-media", `${B}/photo.webp`, `${A}/keep.webp`);
const work = new FakeStorageWork(tables, { authExists: (id) => !deleted.includes(id), onAudit: (entry) => { audits.push(entry); } });
mock.module("@/lib/supabase/server", { namedExports: {
  isSupabaseConfigured: () => true,
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user } }),
      getSession: async () => ({ data: { session: { access_token: `h.${Buffer.from(JSON.stringify({ aal })).toString("base64url")}.s` } } }),
    },
    rpc: async (name: string) => {
      if (name === "is_admin") return { data: isAdmin, error: null };
      throw new Error("unexpected session RPC: " + name);
    },
  }),
  createServiceClient: () => {
    services++;
    return {
      from: work.from,
      rpc: work.rpc,
      storage: storage.storage,
      auth: { admin: { deleteUser: async (id: string) => { deleted.push(id); return { error: null }; } } },
    };
  },
} });
mock.module("@/lib/data", { namedExports: { recordAudit: async (entry: Record<string, unknown>) => { audits.push(entry); } } });

async function main() {
  const { POST } = await import("./route");
  const remove = () => POST(new Request("http://localhost/api/admin/account/delete", {
    method: "POST", body: JSON.stringify({ id: B, email: "target@example.test" }),
  }));
  // Editable metadata claims admin, but is_admin() is authoritative.
  assert.equal((await remove()).status, 403);
  const signedIn = user;
  user = null;
  assert.equal((await remove()).status, 401);
  user = signedIn;
  isAdmin = true;
  aal = "aal1";
  assert.equal((await remove()).status, 403);
  assert.equal(services, 0);
  assert.equal(storage.removals.length, 0);
  aal = "aal2";
  storage.removeFailures = 3;
  const failed = await remove();
  assert.equal(failed.status, 500);
  assert.equal((await failed.json()).error, "storage_cleanup_failed");
  assert.equal(deleted.length, 0);
  assert.equal(audits.length, 0);
  assert.equal(tables.rows("profiles")[0].role, "admin", "failed cleanup restores the reserved admin role");
  assert.equal(tables.rows("fan_passes").length, 1);
  assert.ok(storage.objects.get("avatars")!.has(`${B}/current.png`));
  storage.removeFailures = 0;
  assert.equal((await remove()).status, 200);
  assert.deepEqual(deleted, [B]);
  assert.deepEqual([...storage.objects.get("avatars")!], [`${A}/keep.png`]);
  assert.deepEqual([...storage.objects.get("creator-media")!], [`${A}/keep.webp`]);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "account.delete");
  assert.equal(audits[0].actorId, A);
  assert.equal(audits[0].targetId, B);
  console.log("admin account deletion: metadata/MFA/auth negatives, storage failure retry, role restore, owner isolation and audit passed");
}
main().catch((error) => { console.error(error); process.exit(1); });
