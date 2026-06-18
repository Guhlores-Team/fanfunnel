import { NextResponse } from "next/server";
import { getMyPublicProfile, setMyPublicProfile } from "@/lib/data";
import { supabaseUrl } from "@/lib/supabase/url";
import { externalUrl } from "@/lib/format";

// Field limits and slug shape enforced before persistence. The slug is further
// normalized in the data layer, so we only need to reject oversized/illegal
// raw input here. The tip URL is validated against its normalized form (see
// `externalUrl`) so bare domains stay valid while non-HTTP(S) schemes such as
// `mailto:`, `tel:`, or `javascript:` are rejected.
const MAX_SLUG_LEN = 64;
const MAX_TAGLINE_LEN = 200;
const MAX_NOTE_LEN = 2000;
const MAX_TIP_URL_LEN = 2048;
const SLUG_RE = /^[A-Za-z0-9 _-]*$/;

function isValidTipUrl(raw: string): boolean {
  if (raw === "") return true;
  if (raw.length > MAX_TIP_URL_LEN) return false;
  let parsed: URL;
  try {
    parsed = new URL(externalUrl(raw));
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

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
  if (
    body.slug !== undefined &&
    (typeof body.slug !== "string" ||
      body.slug.length > MAX_SLUG_LEN ||
      !SLUG_RE.test(body.slug))
  ) {
    return NextResponse.json({ error: "invalid_slug" }, { status: 400 });
  }
  if (
    body.tipUrl !== undefined &&
    (typeof body.tipUrl !== "string" || !isValidTipUrl(body.tipUrl))
  ) {
    return NextResponse.json({ error: "invalid_tip_url" }, { status: 400 });
  }
  if (
    body.tagline !== undefined &&
    (typeof body.tagline !== "string" || body.tagline.length > MAX_TAGLINE_LEN)
  ) {
    return NextResponse.json({ error: "invalid_tagline" }, { status: 400 });
  }
  if (
    body.note !== undefined &&
    (typeof body.note !== "string" || body.note.length > MAX_NOTE_LEN)
  ) {
    return NextResponse.json({ error: "invalid_note" }, { status: 400 });
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
