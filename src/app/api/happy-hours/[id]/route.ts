import { NextResponse } from "next/server";
import { deleteHappyHour } from "@/lib/data";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const result = await deleteHappyHour(id);
  if ("error" in result) {
    const status = result.error === "unauthorized" ? 401 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json(result);
}
