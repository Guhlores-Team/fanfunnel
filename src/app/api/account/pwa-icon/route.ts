import { NextResponse } from "next/server";
import { getMyPwaIconMode, setMyPwaIconMode } from "@/lib/data";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";

// Settings › Public page › Home-screen icon (RM-4, D8): what fans' installed
// spin links show. Session client only; the signed-in creator can read and set
// THEIR OWN choice. The body carries the mode and nothing else: any id in it is
// ignored, and the RPC behind it writes auth.uid()'s row only.
export async function GET() {
  const result = await getMyPwaIconMode();
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
}

export async function PUT(req: Request) {
  const body = await parseJsonBody<{ mode?: unknown }>(req);
  if (body === BAD_REQUEST || body === null || typeof body !== "object") return badRequest();
  const result = await setMyPwaIconMode(body.mode);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
