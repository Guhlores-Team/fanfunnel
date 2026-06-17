import { NextResponse } from "next/server";
import { setMyNotificationPrefs } from "@/lib/data";

// Persist the creator's notification preferences (per account). Each flag is
// coerced to a boolean; the data layer uses a narrow SECURITY DEFINER RPC.
export async function PUT(req: Request) {
  let body: { newSpin?: unknown; lowBalance?: unknown; messages?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

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
