import { NextResponse } from "next/server";
import { isSupabaseConfigured, createClient, createServiceClient } from "@/lib/supabase/server";
import { rateLimitOr429 } from "@/lib/api/limit";
import { trackedCreatorUpload } from "@/lib/storage/work";
import { processUpload } from "@/lib/creatorTheme/processImage";

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

// Upload an avatar image to the public `avatars` bucket and return its URL.
// Auth'd creator only; the upload itself uses the service key (bucket has no
// per-object RLS). The returned URL is then saved via the public-profile form.
export async function POST(req: Request) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: "demo_mode" }, { status: 400 });
  }
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // The service upload bypasses RLS. Use the session's server-controlled
  // active/approval predicate, never editable auth metadata, before any write.
  try {
    const { data: active, error } = await sb.rpc("current_user_active");
    if (error || active !== true) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  } catch {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Cap upload frequency per creator to protect storage/compute budget.
  const limited = await rateLimitOr429("avatar:" + user.id, 10, 60_000);
  if (limited) return limited;

  let file: File | null = null;
  try {
    const form = await req.formData();
    file = form.get("file") as File | null;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!file) return NextResponse.json({ error: "no_file" }, { status: 400 });
  if (file.size > MAX_BYTES)
    return NextResponse.json({ error: "too_large" }, { status: 400 });

  const bytes = new Uint8Array(await file.arrayBuffer());
  // Decode/re-encode before registration or upload: EXIF/GPS, appended data,
  // SVG and magic-prefix spoofs never become public avatar objects.
  const image = await processUpload(bytes);
  if ("error" in image) return NextResponse.json({ error: image.error }, { status: 400 });
  // Random, collision-free object name (Date.now() could collide on same-ms
  // uploads and overwrite via upsert:true).
  const path = `${user.id}/${crypto.randomUUID()}.webp`;

  const svc = createServiceClient();
  const result = await trackedCreatorUpload(svc, {
    owner: user.id, bucket: "avatars", path, bytes: image.webp, contentType: "image/webp",
    authorize: async () => {
      const eligibility = await sb.rpc("current_user_active");
      return !eligibility.error && eligibility.data === true;
    },
  });
  if ("error" in result) return NextResponse.json({ error: result.error }, {
    status: result.error === "forbidden" ? 403 : result.error === "upload_failed" ? 400 : result.error === "storage_cleanup_failed" ? 500 : 503,
  });

  const { data } = svc.storage.from("avatars").getPublicUrl(path);
  return NextResponse.json({ url: data.publicUrl });
}
