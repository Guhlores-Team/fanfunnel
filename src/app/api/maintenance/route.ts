import { NextResponse } from "next/server";
import { MAINTENANCE_HEADERS, maintenanceOn } from "@/lib/ops/maintenance";

// OPS-12: where next.config.ts sends cookieless API calls while FF_MAINTENANCE=1.
// Nothing is read or written: every method answers 503 with Retry-After.
function reply() {
  if (!maintenanceOn()) return NextResponse.json({ error: "not_found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  return NextResponse.json({ error: "maintenance" }, { status: 503, headers: MAINTENANCE_HEADERS });
}
export const GET = reply;
export const HEAD = reply;
export const POST = reply;
export const PUT = reply;
export const PATCH = reply;
export const DELETE = reply;
