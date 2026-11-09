import { NextResponse } from "next/server";
import { limitRoute } from "@/lib/api/limit";
import { MAINTENANCE_HEADERS, maintenanceOn } from "@/lib/ops/maintenance";

// OPS-12: where next.config.ts sends cookieless API calls while FF_MAINTENANCE=1.
// Nothing is read or written: every method answers 503 with Retry-After.
async function reply(req: Request) {
  const limited = await limitRoute(req, "maintenance", "public");
  if (limited) {
    limited.headers.set("Cache-Control", "no-store");
    return limited;
  }
  if (!maintenanceOn()) return NextResponse.json({ error: "not_found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  return NextResponse.json({ error: "maintenance" }, { status: 503, headers: MAINTENANCE_HEADERS });
}
export async function GET(req: Request) { return reply(req); }
export async function HEAD(req: Request) { return reply(req); }
export async function POST(req: Request) { return reply(req); }
export async function PUT(req: Request) { return reply(req); }
export async function PATCH(req: Request) { return reply(req); }
export async function DELETE(req: Request) { return reply(req); }
