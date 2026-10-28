import assert from "node:assert/strict";
import { mock } from "node:test";

const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const B = "bbbbbbbb-0000-4000-8000-00000000000b";
let configured = true;
let user: { id: string; user_metadata: Record<string, unknown> } | null = { id: A, user_metadata: { role: "admin", is_active: true, approval_status: "approved" } };
let active: unknown = true;
let rpcError = false;
let rpcThrows = false;
let services = 0;
let publicUrls = 0;
let holdUpload = false;
let removeFailures = 0;
const gate: { release?: () => void; started?: () => void } = {};
const uploads: string[] = [];
const removals: string[][] = [];
mock.module("@/lib/supabase/server", { namedExports: {
  isSupabaseConfigured: () => configured,
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user } }) },
    rpc: async (name: string) => {
      assert.equal(name, "current_user_active");
      if (rpcThrows) throw new Error("unavailable");
      return { data: active, error: rpcError ? { message: "unavailable" } : null };
    },
  }),
  createServiceClient: () => {
    services++;
    return { storage: { from: (bucket: string) => {
      assert.equal(bucket, "avatars");
      return {
        upload: async (path: string) => {
          uploads.push(path);
          if (holdUpload) {
            const pending = new Promise<void>((resolve) => { gate.release = resolve; });
            gate.started?.();
            await pending;
          }
          return { error: null };
        },
        remove: async (paths: string[]) => {
          removals.push(paths);
          return { error: removeFailures-- > 0 ? { message: "unavailable" } : null };
        },
        getPublicUrl: (path: string) => { publicUrls++; return { data: { publicUrl: `https://cdn.test/${path}` } }; },
      };
    } } };
  },
} });
mock.module("@/lib/api/limit", { namedExports: { rateLimitOr429: async () => null } });

async function main() {
  const { POST } = await import("./route");
  const upload = () => {
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]), "photo.png");
    form.set("creatorId", B);
    return POST(new Request("http://localhost/api/account/avatar", { method: "POST", body: form }));
  };
  configured = false;
  assert.equal((await upload()).status, 400);
  configured = true;
  const signedIn = user;
  user = null;
  assert.equal((await upload()).status, 401);
  user = signedIn;
  // Pending, rejected and suspended all resolve false in the server predicate;
  // forged metadata cannot override that authoritative result.
  for (const status of ["pending", "rejected", "suspended"]) {
    active = false;
    assert.equal((await upload()).status, 403, status);
  }
  for (active of [null, undefined, "true", 1]) assert.equal((await upload()).status, 403);
  active = true;
  rpcError = true;
  assert.equal((await upload()).status, 403);
  rpcError = false;
  rpcThrows = true;
  assert.equal((await upload()).status, 403);
  rpcThrows = false;
  assert.equal(services, 0);
  assert.equal(uploads.length, 0);
  assert.equal((await upload()).status, 200);
  assert.equal(uploads.length, 1);
  assert.ok(uploads[0].startsWith(`${A}/`));
  assert.ok(!uploads[0].includes(B));
  assert.equal(publicUrls, 1);
  for (const cleanupFails of [false, true]) {
    active = true;
    holdUpload = true;
    removeFailures = cleanupFails ? 3 : 0;
    const started = new Promise<void>((resolve) => { gate.started = resolve; });
    const pending = upload();
    await started;
    active = false; // Suspension/closure occurred while the upload was pending.
    gate.release!();
    const revoked = await pending;
    assert.equal(revoked.status, cleanupFails ? 500 : 403);
    const body = await revoked.json();
    assert.equal(body.error, cleanupFails ? "storage_cleanup_failed" : "forbidden");
    assert.equal(body.url, undefined);
    assert.equal(publicUrls, 1, "a revoked uploader never receives a public URL");
    const path: string = uploads[uploads.length - 1];
    assert.deepEqual(removals[removals.length - 1], [path]);
    assert.ok(path.startsWith(`${A}/`) && !path.includes(B));
  }
  console.log("avatar route: approval/auth negatives, own prefix, delayed-upload revocation and explicit cleanup failures passed");
}
main().catch((error) => { console.error(error); process.exit(1); });
