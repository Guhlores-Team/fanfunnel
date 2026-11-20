import assert from "node:assert/strict";
import { mock } from "node:test";
import { FakeTables } from "@/lib/privacy/fakeTables";
import { FakeStorageWork } from "@/lib/storage/fakeWork";
import sharp from "sharp";

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
const stored: { bytes: Buffer; contentType: string; upsert: boolean }[] = [];
const removals: string[][] = [];
const work = new FakeStorageWork(new FakeTables({ profiles: [{ id: A, role: "creator", is_active: true, approval_status: "approved" }] }), {
  active: (owner) => owner === user?.id && active === true && !rpcError && !rpcThrows,
});
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
    return { rpc: work.rpc, from: work.from, storage: { from: (bucket: string) => {
      assert.equal(bucket, "avatars");
      return {
        upload: async (path: string, bytes: Uint8Array, options: { contentType: string; upsert: boolean }) => {
          assert.ok(work.tables.rows("creator_storage_objects").some((row) => row.path === path), "durable intent exists before bytes are dispatched");
          uploads.push(path);
          stored.push({ bytes: Buffer.from(bytes), ...options });
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
  const jpeg = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: "#3366cc" } })
    .withExif({ IFD0: { Model: "PRIVATE-CAMERA" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "51/1 30/1 0/1" } }).jpeg().toBuffer();
  const original = await sharp(jpeg).metadata();
  assert.ok(original.exif?.includes(Buffer.from("PRIVATE-CAMERA")), "fixture really contains EXIF");
  assert.ok(original.exif?.includes(Buffer.from([0x25, 0x88])), "fixture really contains the GPS IFD");
  const upload = (bytes: Uint8Array = jpeg) => {
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }), "photo.jpg");
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
  for (const malformed of [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("\xff\xd8\xff<html><script>bad</script></html>", "latin1"), Buffer.from("<svg onload='bad()' />")]) {
    const refused = await upload(malformed);
    assert.equal(refused.status, 400);
    assert.equal((await refused.json()).error, "not_image");
  }
  assert.equal(services, 0, "malformed images never register a write or reach storage");
  assert.equal((await upload()).status, 200);
  assert.equal(uploads.length, 1);
  assert.ok(uploads[0].startsWith(`${A}/`));
  assert.ok(!uploads[0].includes(B));
  assert.ok(uploads[0].endsWith(".webp"));
  assert.equal(stored[0].contentType, "image/webp");
  assert.equal(stored[0].upsert, false);
  const clean = await sharp(stored[0].bytes).metadata();
  assert.equal(clean.format, "webp");
  assert.equal(clean.width, 1600);
  assert.equal(clean.height, 800);
  assert.ok(!clean.exif && !clean.xmp && !clean.iptc && !clean.icc, "all identifying metadata is stripped");
  assert.ok(!stored[0].bytes.includes(Buffer.from("PRIVATE-CAMERA")));
  assert.equal(publicUrls, 1);
  for (const cleanupFails of [false, true]) {
    active = true;
    holdUpload = true;
    removeFailures = cleanupFails ? 3 : 0;
    const started = new Promise<void>((resolve) => { gate.started = resolve; });
    const pending = upload();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([started, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("upload did not reach storage")), 5000); })]);
    } finally { clearTimeout(deadline); }
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
    if (cleanupFails) assert.ok(work.tables.rows("creator_storage_objects").some((row) => row.path === path && !row.removed_at), "failed cleanup keeps a durable retry path");
  }
  console.log("avatar route: approval/auth negatives, own prefix, delayed-upload revocation and explicit cleanup failures passed");
}
main().catch((error) => { console.error(error); process.exit(1); });
