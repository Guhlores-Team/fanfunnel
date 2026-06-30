import { NextResponse } from "next/server";
import { deleteHappyHour } from "@/lib/data";
import { errorResponse } from "@/lib/api/handler";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const result = await deleteHappyHour(id);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
