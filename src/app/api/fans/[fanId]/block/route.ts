import { NextResponse } from "next/server";
import { setFanBlocked } from "@/lib/data";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";

// Creator blocks/unblocks a fan. Body: { blocked: boolean }.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ fanId: string }> }
) {
  const { fanId } = await params;
  const body = await parseJsonBody<{ blocked?: boolean }>(req);
  if (body === BAD_REQUEST) return badRequest();
  const result = await setFanBlocked(fanId, Boolean(body.blocked));
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
