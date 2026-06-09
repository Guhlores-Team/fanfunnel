import { NextResponse } from "next/server";
import { isSupabaseConfigured, createClient, createServiceClient } from "@/lib/supabase/server";
import { rateLimitOr429 } from "@/lib/api/limit";

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const ALLOWED_EXT = new Set(["jpg", "jpeg", "png", "gif", "webp"]);

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

  // Cap upload frequency per creator to protect storage/compute budget.
  const limited = rateLimitOr429("avatar:" + user.id, 10, 60_000);
  if (limited) return limited;

  let file: File | null = null;
  try {
    const form = await req.formData();
    file = form.get("file") as File | null;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!file) return NextResponse.json({ error: "no_file" }, { status: 400 });
  if (!file.type.startsWith("image/"))
    return NextResponse.json({ error: "not_image" }, { status: 400 });
  if (file.size > MAX_BYTES)
    return NextResponse.json({ error: "too_large" }, { status: 400 });

  let ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!ALLOWED_EXT.has(ext)) ext = "jpg";
  const path = `${user.id}/${Date.now()}.${ext}`;
  const bytes = new Uint8Array(await file.arrayBuffer());

  const svc = createServiceClient();
  const { error } = await svc.storage
    .from("avatars")
    .upload(path, bytes, { contentType: file.type, upsert: true });
  if (error) return NextResponse.json({ error: "upload_failed" }, { status: 400 });

  const { data } = svc.storage.from("avatars").getPublicUrl(path);
  return NextResponse.json({ url: data.publicUrl });
}
