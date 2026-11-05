import { NextResponse } from "next/server";
import { BAD_REQUEST, badRequest, parseJsonBody } from "@/lib/api/handler";
import { setMyDisplayName } from "@/lib/data";
import { revalidateMyPublicPage } from "@/lib/api/publicPage";
import { limitRoute } from "@/lib/api/limit";

// Update the creator's display name (Account → Settings). The data layer routes
// this through a narrow SECURITY DEFINER RPC since profiles_update is admin-only.
export async function PUT(req: Request) {
  const rateLimited = await limitRoute(req, "account/profile:PUT");
  if (rateLimited) return rateLimited;
  const body = await parseJsonBody<{ displayName?: unknown }>(req);
  if (body === BAD_REQUEST) return badRequest();

  const name = typeof body.displayName === "string" ? body.displayName.trim() : "";
  if (!name) return NextResponse.json({ error: "name_required" }, { status: 400 });
  if (name.length > 80) return NextResponse.json({ error: "name_too_long" }, { status: 400 });

  const result = await setMyDisplayName(name);
  if ("error" in result) {
    const status = result.error === "unauthorized" ? 401 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  await revalidateMyPublicPage();
  return NextResponse.json({ ok: true, displayName: name });
}
