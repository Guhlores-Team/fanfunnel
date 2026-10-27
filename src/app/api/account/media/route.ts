import { NextResponse } from "next/server";
import { addMyMedia, reorderMyMedia } from "@/lib/data";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { rateLimitOr429 } from "@/lib/api/limit";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";
import { revalidateMyThemedPublicPage } from "@/lib/api/publicPage";
import { MAX_UPLOAD_BYTES } from "@/lib/creatorTheme/config";

// Photo hub uploads (per-creator theming). Follows the avatar route: a signed-in
// creator only, rate-limited, size-capped, magic-byte sniffed (no SVG), then
// RE-ENCODED to a metadata-free WebP before anything is stored (see
// addMyMedia / processImage). The object lands at a random path in the
// creator's own folder; there is no way to name a path, a creator or a URL.
export async function POST(req: Request) {
  let limitKey = "media:demo";
  if (isSupabaseConfigured()) {
    const {
      data: { user },
    } = await (await createClient()).auth.getUser();
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    limitKey = "media:" + user.id;
  }
  const limited = await rateLimitOr429(limitKey, 10, 60_000);
  if (limited) return limited;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return badRequest();
  }
  const file = form.get("file");
  if (!file || typeof file === "string") return errorResponse("no_file");
  if (file.size > MAX_UPLOAD_BYTES) return errorResponse("too_large");
  const result = await addMyMedia({
    bytes: new Uint8Array(await file.arrayBuffer()),
    caption: form.get("caption"),
    sfwAttested: form.get("sfw") === "yes",
  });
  if ("error" in result) return errorResponse(result.error);
  await revalidateMyThemedPublicPage();
  return NextResponse.json(result);
}

// Re-order the creator's own photos: { order: [id, …] }.
export async function PATCH(req: Request) {
  const body = await parseJsonBody<{ order?: unknown }>(req);
  if (body === BAD_REQUEST || body === null || typeof body !== "object") return badRequest();
  const result = await reorderMyMedia(body.order);
  if ("error" in result) return errorResponse(result.error);
  await revalidateMyThemedPublicPage();
  return NextResponse.json(result);
}
