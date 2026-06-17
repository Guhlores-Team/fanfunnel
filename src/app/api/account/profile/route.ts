import { NextResponse } from "next/server";
import { setMyDisplayName } from "@/lib/data";

// Update the creator's display name (Account → Settings). The data layer routes
// this through a narrow SECURITY DEFINER RPC since profiles_update is admin-only.
export async function PUT(req: Request) {
  let body: { displayName?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const name = typeof body.displayName === "string" ? body.displayName.trim() : "";
  if (!name) return NextResponse.json({ error: "name_required" }, { status: 400 });
  if (name.length > 80) return NextResponse.json({ error: "name_too_long" }, { status: 400 });

  const result = await setMyDisplayName(name);
  if ("error" in result) {
    const status = result.error === "unauthorized" ? 401 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json({ ok: true, displayName: name });
}
