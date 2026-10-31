import { NextResponse } from "next/server";
import { isCurrentUserAdmin } from "@/lib/data";
import { limitRoute } from "@/lib/api/limit";

// Lightweight identity probe: whether the signed-in user is an admin. Used to
// gate admin-only UI (the in-app debug console) without shipping a global admin
// flag to every page. Returns { isAdmin: false } for anon/demo.
export async function GET(req: Request) {
  const rateLimited = await limitRoute(req, "me:GET", "public");
  if (rateLimited) return rateLimited;
  return NextResponse.json({ isAdmin: await isCurrentUserAdmin() });
}
