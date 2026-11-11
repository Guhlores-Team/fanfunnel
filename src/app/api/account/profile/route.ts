import { NextResponse } from "next/server";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";
import { displayNameInputError } from "@/lib/profileErrors";
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
  // The 0071 rule (length, control characters, never an e-mail), checked here
  // too so the demo answers like the database; set_display_name stays the
  // authority and its refusals arrive as the same codes.
  const invalid = displayNameInputError(name);
  if (invalid) return badRequest(invalid);

  const result = await setMyDisplayName(name);
  if ("error" in result) return errorResponse(result.error);
  await revalidateMyPublicPage();
  return NextResponse.json({ ok: true, displayName: name });
}
