import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase/server";
import { ageFanActivityForDemo } from "@/lib/data";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";

// Demo/e2e only: move a demo fan's activity N days into the past so the
// win-back queue (fans quiet for 14+ days) can be exercised in the in-memory
// demo. It exists only in a debug build (NEXT_PUBLIC_ENABLE_DEBUG=1) running
// WITHOUT Supabase; everywhere else, including production and every Preview,
// it is a plain 404 and touches nothing.
const enabled = () => process.env.NEXT_PUBLIC_ENABLE_DEBUG === "1" && !isSupabaseConfigured();

export async function POST(req: Request) {
  if (!enabled()) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const body = await parseJsonBody<{ fanId?: unknown; days?: unknown }>(req);
  if (body === BAD_REQUEST || body === null || typeof body !== "object") return badRequest();
  const { fanId, days } = body;
  if (typeof fanId !== "string" || !fanId) return badRequest();
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 365) return badRequest();
  const result = ageFanActivityForDemo(fanId, days);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
