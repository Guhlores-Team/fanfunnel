import { NextResponse } from "next/server";
import { isCurrentUserAdmin } from "@/lib/data";

// Lightweight identity probe: whether the signed-in user is an admin. Used to
// gate admin-only UI (the in-app debug console) without shipping a global admin
// flag to every page. Returns { isAdmin: false } for anon/demo.
export async function GET() {
  return NextResponse.json({ isAdmin: await isCurrentUserAdmin() });
}
