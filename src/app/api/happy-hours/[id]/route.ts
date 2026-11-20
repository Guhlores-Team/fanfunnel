import { NextResponse } from "next/server";
import { deleteHappyHour } from "@/lib/data";
import { errorResponse } from "@/lib/api/handler";
import { limitRoute } from "@/lib/api/limit";

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const rateLimited = await limitRoute(req, "happy-hours/[id]:DELETE");
  if (rateLimited) return rateLimited;
  const { id } = await params;
  const result = await deleteHappyHour(id);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
