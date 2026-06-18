import { NextResponse } from "next/server";
import { getMyPublicProfile, setMyPublicProfile } from "@/lib/data";
import { supabaseUrl } from "@/lib/supabase/url";

// The signed-in creator's link-in-bio settings.
export async function GET() {
  const profile = await getMyPublicProfile();
  return NextResponse.json(profile);
}

// Only avatar URLs produced by our trusted `avatars` storage bucket may be
// persisted. The avatar upload endpoint returns Supabase public URLs shaped
// like `${origin}/storage/v1/object/public/avatars/...`; accepting anything
// else would let a creator point every public-profile visitor's browser at an
// arbitrary external/data URL, bypassing the validated upload path. An empty
// string is allowed so the avatar can be cleared.
function isTrustedAvatarUrl(url: string): boolean {
  if (url === "") return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  let origin: string;
  try {
    origin = new URL(supabaseUrl()).origin;
  } catch {
    return false;
  }
  return (
    parsed.origin === origin &&
    parsed.pathname.startsWith("/storage/v1/object/public/avatars/")
  );
}

export async function PUT(req: Request) {
  let body: { slug?: string; tipUrl?: string; tagline?: string; note?: string; avatarUrl?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (body.avatarUrl !== undefined && !isTrustedAvatarUrl(body.avatarUrl)) {
    return NextResponse.json({ error: "invalid_avatar_url" }, { status: 400 });
  }
  const result = await setMyPublicProfile({
    slug: body.slug ?? "",
    tipUrl: body.tipUrl ?? "",
    tagline: body.tagline ?? "",
    note: body.note,
    avatarUrl: body.avatarUrl,
  });
  if ("error" in result) {
    const status = result.error === "unauthorized" ? 401 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json(result);
}
