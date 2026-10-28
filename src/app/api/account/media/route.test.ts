import assert from "node:assert";
import { mock } from "node:test";
import sharp from "sharp";
import { FakeTables } from "@/lib/privacy/fakeTables";
import { FakeStorageWork } from "@/lib/storage/fakeWork";

// AUTH-SENSITIVE (AGENTS.md rules 3/5/7): the photo hub (per-creator theming,
// migration 0058). Uploads write to storage with the service role, so this
// route + addMyMedia ARE the authorization for the write.
//
// Negative tests:
//   * signed out → 401 for upload, caption, re-order and delete; nothing stored;
//   * a suspended account, a full hub (12), a missing SFW attestation, SVG,
//     HTML, oversize → refused BEFORE any storage write;
//   * a form that names another creator, a path or a bucket changes nothing:
//     the object always lands at "<own id>/<random uuid>.webp", re-encoded
//     (no EXIF/GPS), and the row is inserted for the signed-in creator only;
//   * caption / re-order / delete on another creator's photo touch nothing
//     (every write is scoped to the signed-in creator; RLS is the second wall)
//     and never remove a storage object that isn't the caller's;
//   * admin "Remove photos" refuses a non-admin with 403.
// The runtime half (RLS, column grants, the 12 cap, server-only inserts) is in
// scripts/db/themeProbe.mjs and scripts/security/rls-runtime-test.mjs.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const B = "bbbbbbbb-0000-4000-8000-00000000000b";
const A_PHOTO = "aaaaaaaa-1111-4000-8000-00000000000a";
const B_PHOTO = "bbbbbbbb-1111-4000-8000-00000000000b";

let user: { id: string; user_metadata?: Record<string, unknown> } | null = null;
let aal = "aal2";
let active = true;
let isAdmin = false;
let count = 0;
let removeFailures = 0;
let removeThrows = false;
let deleteDbFails = false;
let losePublicationAck = false;
let holdUpload = false;
const uploadGate: { started?: () => void; release?: () => void } = {};
const operations: string[] = [];
const centralAudits: Record<string, unknown>[] = [];
// Rows as the session (RLS) would see them: only the signed-in creator's.
const rows = [
  { id: A_PHOTO, creator_id: A, path: `${A}/${A_PHOTO}.webp` },
  { id: B_PHOTO, creator_id: B, path: `${B}/${B_PHOTO}.webp` },
];
const uploads: { path: string; bytes: Buffer; contentType?: string; upsert?: boolean }[] = [];
const removes: string[][] = [];
const inserts: Record<string, unknown>[] = [];
const sessionWrites: { op: string; filters: Record<string, unknown>; values?: unknown }[] = [];
const dbAudits: Record<string, unknown>[] = [];
const work = new FakeStorageWork(new FakeTables({
  profiles: [{ id: A, role: "creator", is_active: true, approval_status: "approved" }, { id: B, role: "creator", is_active: true, approval_status: "approved" }],
  creator_media: rows,
}), {
  active: (owner) => owner === user?.id && active,
  admin: (actor) => actor === user?.id && isAdmin,
  insertMedia: (row) => { inserts.push(row); return true; },
  onAudit: (entry) => { dbAudits.push(entry); },
  removeMedia: (id, owner, path) => {
    operations.push("delete-row");
    if (deleteDbFails) return false;
    const index = rows.findIndex((row) => row.id === id && row.creator_id === owner && row.path === path);
    if (index >= 0) rows.splice(index, 1);
    return true;
  },
});

/** A session query builder that applies eq filters and RLS (own rows only). */
function sessionTable(table: string) {
  const filters: Record<string, unknown> = {};
  const included: Record<string, unknown[]> = {};
  let op = "select";
  let values: unknown;
  let head = false;
  const visible = () =>
    rows.filter(
      (r) =>
        (isAdmin || (user && r.creator_id === user.id)) &&
        Object.entries(filters).every(([k, v]) => (r as Record<string, unknown>)[k] === v) &&
        Object.entries(included).every(([k, v]) => v.includes((r as Record<string, unknown>)[k]))
    );
  const result = () => {
    if (op === "select" && head) return { data: null, count, error: null };
    if (op === "select") return { data: visible(), error: null };
    sessionWrites.push({ op, filters: { ...filters }, values });
    if (op === "delete") {
      operations.push("delete-row");
      if (deleteDbFails) return { data: null, error: { message: "unavailable" } };
    }
    const hit = visible();
    if (op === "delete") for (const h of hit) rows.splice(rows.indexOf(h), 1);
    return { data: hit.map((r) => ({ id: r.id, path: r.path })), error: null };
  };
  const b: Record<string, unknown> = {
    select: (_c?: string, opts?: { head?: boolean }) => ((head = !!opts?.head), b),
    update: (v: unknown) => ((op = "update"), (values = v), b),
    delete: () => ((op = "delete"), b),
    eq: (k: string, v: unknown) => ((filters[k] = v), b),
    in: (k: string, v: unknown[]) => ((included[k] = v), b),
    order: () => b,
    maybeSingle: async () => ({ data: table === "profiles" ? { theme: {} } : null, error: null }),
    then: (resolve: (v: unknown) => void) => resolve(result()),
  };
  return b;
}

const session = {
  auth: {
    getUser: async () => ({ data: { user }, error: null }),
    getSession: async () => ({ data: { session: { access_token: `h.${Buffer.from(JSON.stringify({ aal })).toString("base64url")}.s` } } }),
  },
  from: (t: string) => sessionTable(t),
  rpc: async (name: string) => {
    if (name === "current_user_active") return { data: active, error: null };
    if (name === "is_admin") return { data: isAdmin, error: null };
    return { data: null, error: { message: "unexpected rpc " + name } };
  },
  storage: { from: () => ({ getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn.test/${p}` } }) }) },
};

const service = {
  rpc: async (name: string, args: Record<string, unknown>) => {
    const result = await work.rpc(name, args);
    if (name === "creator_storage_publish_media" && losePublicationAck) throw new Error("response lost after atomic commit");
    return result;
  },
  storage: {
    from: (bucket: string) => {
      assert.equal(bucket, "creator-media", "only the creator-media bucket is ever written");
      return {
        upload: async (path: string, bytes: Buffer, opts: { contentType?: string; upsert?: boolean }) => {
          assert.ok(work.tables.rows("creator_storage_objects").some((row) => row.path === path), "upload intent committed before bytes");
          uploads.push({ path, bytes, ...opts });
          if (holdUpload) {
            const pending = new Promise<void>((resolve) => { uploadGate.release = resolve; });
            uploadGate.started?.();
            await pending;
          }
          return { data: { path }, error: null };
        },
        remove: async (paths: string[]) => {
          operations.push("remove-object");
          removes.push(paths);
          if (removeThrows) throw new Error("transport unavailable");
          if (removeFailures-- > 0) return { data: null, error: { status: 403, message: "unavailable" } };
          return { data: [], error: null };
        },
        getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn.test/${p}` } }),
      };
    },
  },
  from: (table: string) => {
    if (table.startsWith("creator_storage_")) return work.from(table);
    assert.equal(table, "creator_media", "the service role only inserts photo rows");
    return {
      insert: (row: Record<string, unknown>) => {
        inserts.push(row);
        const out = { id: "cccccccc-0000-4000-8000-00000000000c", ...row };
        return { select: () => ({ single: async () => ({ data: out, error: null }) }) };
      },
    };
  },
};

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service";

mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => true,
    createClient: async () => session,
    createServiceClient: () => service,
  },
});
mock.module("@/lib/data/audit", { namedExports: { recordAudit: async (entry: Record<string, unknown>) => { centralAudits.push(entry); } } });
mock.module("next/cache", { namedExports: { revalidatePath: () => {} } });
// Quotas have their own suite; these cases exercise authorization/storage,
// including more than ten uploads in one test process.
mock.module("@/lib/api/limit", { namedExports: { rateLimitOr429: async () => null } });

async function main() {
  const media = await import("./route");
  const one = await import("./[id]/route");
  const adminRoute = await import("@/app/api/admin/account/media/route");

  const jpeg = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: "#c026d3" } })
    .withExif({ IFD0: { Model: "SECRET-MODEL" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "51/1 30/1 0/1" } })
    .jpeg()
    .toBuffer();
  const upload = async (file: Blob | null, fields: Record<string, string> = { sfw: "yes" }) => {
    const form = new FormData();
    if (file) form.append("file", file, "x.jpg");
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    const res = await media.POST(new Request("http://localhost/api/account/media", { method: "POST", body: form }));
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  };
  const json = (method: string, body: unknown) =>
    new Request("http://localhost/api/account/media", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const jpegBlob = () => new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" });
  const nothingStored = () => uploads.length === 0 && inserts.length === 0;

  // --- 1. Signed out --------------------------------------------------------------
  user = null;
  {
    check("upload signed out → 401", (await upload(jpegBlob())).status === 401);
    check("caption signed out → 401", (await one.PATCH(json("PATCH", { caption: "x" }), params(A_PHOTO))).status === 401);
    check("re-order signed out → 401", (await media.PATCH(json("PATCH", { order: [A_PHOTO] }))).status === 401);
    check("delete signed out → 401", (await one.DELETE(json("DELETE", {}), params(A_PHOTO))).status === 401);
    check("signed out → nothing stored, nothing removed", nothingStored() && removes.length === 0 && sessionWrites.length === 0);
  }

  // --- 2. Refusals before any storage write ----------------------------------------
  user = { id: A };
  {
    const svg = new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'], { type: "image/jpeg" });
    check("SVG (declared as JPEG) → 400 not_image", (await upload(svg)).data.error === "not_image");
    const html = new Blob(["\xff\xd8\xff<html><script>alert(1)</script></html>"], { type: "image/jpeg" });
    check("HTML behind JPEG magic → 400 not_image", (await upload(html)).data.error === "not_image");
    check("no SFW attestation → 400 sfw_required", (await upload(jpegBlob(), {})).data.error === "sfw_required");
    check("SFW 'no' → 400 sfw_required", (await upload(jpegBlob(), { sfw: "no" })).data.error === "sfw_required");
    check("no file → 400 no_file", (await upload(null)).data.error === "no_file");
    const big = new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: "image/jpeg" });
    check("over 5 MB → 400 too_large", (await upload(big)).data.error === "too_large");
    count = 12;
    check("a full hub (12) → 400 limit_reached", (await upload(jpegBlob())).data.error === "limit_reached");
    count = 0;
    active = false;
    check("a suspended account → 403", (await upload(jpegBlob())).status === 403);
    active = true;
    check("every refusal stored nothing", nothingStored());
  }

  // --- 3. A good upload, with a form trying to aim it elsewhere ---------------------
  {
    const r = await upload(jpegBlob(), {
      sfw: "yes",
      caption: "  Golden hour \u0000 ",
      creatorId: B,
      creator_id: B,
      path: `${B}/evil.webp`,
      bucket: "avatars",
    });
    check("upload → 200", r.status === 200 && r.data.ok === true);
    check("exactly one object stored", uploads.length === 1);
    const u = uploads[0];
    check("stored in the signed-in creator's folder at a random .webp path", new RegExp(`^${A}/[0-9a-f-]{36}\\.webp$`).test(u.path));
    check("stored as image/webp, never overwriting", u.contentType === "image/webp" && u.upsert === false);
    const meta = await sharp(u.bytes).metadata();
    check("the stored bytes are a re-encoded WebP", meta.format === "webp" && meta.width === 1600 && meta.height === 800);
    check("the stored bytes carry no EXIF / GPS", !meta.exif && !u.bytes.includes(Buffer.from("SECRET-MODEL")));
    check("one row inserted, for the signed-in creator", inserts.length === 1 && inserts[0].creator_id === A && inserts[0].path === u.path);
    check("the row carries the SFW attestation time", typeof inserts[0].sfw_attested_at === "string");
    check("the caption is cleaned", inserts[0].caption === "Golden hour");
    check("the response URL is the public URL of that path", (r.data.media as { url: string }).url === `https://cdn.test/${u.path}`);

    for (const cleanupFails of [false, true]) {
      holdUpload = true;
      active = true;
      removeFailures = cleanupFails ? 3 : 0;
      const beforeInsert = inserts.length;
      const started = new Promise<void>((resolve) => { uploadGate.started = resolve; });
      const pending = upload(jpegBlob());
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([started, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("upload did not reach storage")), 5000); })]);
      } finally {
        clearTimeout(deadline);
      }
      active = false;
      uploadGate.release!();
      const revoked = await pending;
      check("revocation during upload returns an explicit refusal", revoked.status === (cleanupFails ? 500 : 403) && revoked.data.error === (cleanupFails ? "storage_cleanup_failed" : "forbidden"));
      check("revoked upload never inserts a row or publishes a URL", inserts.length === beforeInsert && revoked.data.media === undefined);
      const path: string = uploads[uploads.length - 1].path;
      check("revocation cleans only the new caller-owned upload", JSON.stringify(removes[removes.length - 1]) === JSON.stringify([path]) && path.startsWith(`${A}/`));
    }
    holdUpload = false;
    active = true;
    removeFailures = 0;
    removes.length = 0;
  }

  // --- 4. Caption / re-order / delete on someone else's photo -----------------------
  {
    sessionWrites.length = 0;
    const cap = await one.PATCH(json("PATCH", { caption: "mine now" }), params(B_PHOTO));
    check("caption on B's photo → 404", cap.status === 404);
    check("…and the update was scoped to the caller", sessionWrites[0]?.filters.creator_id === A);
    const del = await one.DELETE(json("DELETE", {}), params(B_PHOTO));
    check("delete B's photo → 404", del.status === 404);
    check("…B's photo still exists", rows.some((r) => r.id === B_PHOTO));
    check("…no storage object removed", removes.length === 0);
    check("a non-uuid id → 404 without a query", (await one.DELETE(json("DELETE", {}), params("../../x"))).status === 404);

    sessionWrites.length = 0;
    const reorder = await media.PATCH(json("PATCH", { order: [B_PHOTO, A_PHOTO] }));
    check("re-order → 200", reorder.status === 200);
    check("every re-order write is scoped to the caller", sessionWrites.length === 2 && sessionWrites.every((w) => w.filters.creator_id === A));
    check("only sort_order is written", sessionWrites.every((w) => JSON.stringify(Object.keys(w.values as object)) === '["sort_order"]'));
    for (const bad of [[A_PHOTO, A_PHOTO], ["x"], Array(13).fill(A_PHOTO), "nope", null]) {
      const r = await media.PATCH(json("PATCH", { order: bad }));
      check(`re-order ${JSON.stringify(bad).slice(0, 40)} → 400`, r.status === 400);
    }

    active = false;
    check("inactive creator cannot remove objects", (await one.DELETE(json("DELETE", {}), params(A_PHOTO))).status === 403 && removes.length === 0);
    active = true;
    for (const transport of [false, true]) {
      removeFailures = 3;
      removeThrows = transport;
      const failed = await one.DELETE(json("DELETE", {}), params(A_PHOTO));
      check("failed storage cleanup returns 500, never ok", failed.status === 500 && (await failed.json()).error === "storage_cleanup_failed");
      check("failed cleanup preserves own row/path for retry", rows.some((r) => r.id === A_PHOTO));
    }
    removeFailures = 0;
    removeThrows = false;
    removes.length = 0;
    operations.length = 0;
    const own = await one.DELETE(json("DELETE", {}), params(A_PHOTO));
    check("delete own photo → 200", own.status === 200);
    check("…removes exactly its own object", removes.length === 1 && JSON.stringify(removes[0]) === JSON.stringify([`${A}/${A_PHOTO}.webp`]));
    check("…storage succeeds before the DB row is deleted", JSON.stringify(operations) === '["remove-object","delete-row"]');

    rows.push({ id: A_PHOTO, creator_id: A, path: `${A}/${A_PHOTO}.webp` });
    deleteDbFails = true;
    const dbFailed = await one.DELETE(json("DELETE", {}), params(A_PHOTO));
    check("a DB delete failure is not reported as success", (await dbFailed.json()).error === "db_error" && rows.some((r) => r.id === A_PHOTO));
    deleteDbFails = false;
    check("retrying after a DB failure completes deletion", (await one.DELETE(json("DELETE", {}), params(A_PHOTO))).status === 200);
  }

  {
    active = true; losePublicationAck = true;
    const before = inserts.length;
    const response = await upload(jpegBlob());
    check("commit-then-error publication is honestly pending, with no public URL", response.status === 503 && response.data.error === "storage_cleanup_pending" && !response.data.media);
    check("lost acknowledgement commits exactly one bound media row", inserts.length === before + 1 && work.tables.rows("creator_storage_objects").some((row) => row.media_id === inserts.at(-1)?.id && row.published_at && !row.removed_at));
    losePublicationAck = false;
  }

  // --- 5. Admin removal is admin-only ------------------------------------------------
  {
    const body = new Request("http://localhost/api/admin/account/media", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: B }),
    });
    removes.length = 0;
    user = { id: A, user_metadata: { role: "admin", is_active: true } };
    const denied = await adminRoute.POST(body.clone());
    check("a creator calling admin Remove photos → 403", denied.status === 403);
    check("…B's photo untouched, nothing removed", rows.some((r) => r.id === B_PHOTO) && removes.length === 0);
    user = null;
    check("signed out → 401", (await adminRoute.POST(body.clone())).status === 401);
    user = { id: A };
    isAdmin = true;
    aal = "aal1";
    const mfaDenied = await adminRoute.POST(body.clone());
    check("an admin without two-factor cannot moderate photos", mfaDenied.status === 403 && (await mfaDenied.json()).error === "mfa_required" && removes.length === 0);
    aal = "aal2";
    removeFailures = 3;
    const failed = await adminRoute.POST(body.clone());
    check("admin storage failure → 500, never ok", failed.status === 500 && (await failed.json()).error === "storage_cleanup_failed");
    check("admin storage failure keeps the photo row/path", rows.some((r) => r.id === B_PHOTO));
    removeFailures = 0;
    removes.length = 0;
    const bRow = rows.find((r) => r.id === B_PHOTO)!;
    bRow.path = `${A}/${B_PHOTO}.webp`;
    const unsafe = await adminRoute.POST(body.clone());
    check("a corrupt path cannot remove another creator's prefix", unsafe.status === 500 && removes.length === 0 && rows.includes(bRow));
    check("failed moderation does not create a success audit", dbAudits.length === 0 && centralAudits.length === 0);
    bRow.path = `${B}/${B_PHOTO}.webp`;
    const ok = await adminRoute.POST(body.clone());
    check("an active admin → 200", ok.status === 200);
    check("SQL audit is not duplicated by the route", centralAudits.length === 0);
    check("completed moderation records an idempotent SQL audit", dbAudits.length === 1 && dbAudits[0].actorId === A && dbAudits[0].targetId === B && dbAudits[0].action === "account.media_remove");
    check("…removes B's object only", JSON.stringify(removes[0]) === JSON.stringify([`${B}/${B_PHOTO}.webp`]));
  }

  console.log(`media routes: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
