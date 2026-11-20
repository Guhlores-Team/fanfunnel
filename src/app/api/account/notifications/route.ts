import { NextResponse } from "next/server";
import { BAD_REQUEST, badRequest, parseJsonBody } from "@/lib/api/handler";
import { setMyNotificationPrefs } from "@/lib/data";
import { limitRoute } from "@/lib/api/limit";

// Persist the creator's notification preferences (per account). Each flag is
// coerced to a boolean; the data layer uses a narrow SECURITY DEFINER RPC.
export async function PUT(req: Request) {
  const rateLimited = await limitRoute(req, "account/notifications:PUT");
  if (rateLimited) return rateLimited;
  const body = await parseJsonBody<{ newSpin?: unknown; lowBalance?: unknown; messages?: unknown }>(req);
  if (body === BAD_REQUEST) return badRequest();

  const prefs = {
    newSpin: body.newSpin !== false,
    lowBalance: body.lowBalance !== false,
    messages: body.messages !== false,
  };

  const result = await setMyNotificationPrefs(prefs);
  if ("error" in result) {
    const status = result.error === "unauthorized" ? 401 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json({ ok: true, notifications: prefs });
}
