import { NextResponse } from "next/server";
import { deleteWheelTemplate } from "@/lib/data";
import { errorResponse } from "@/lib/api/handler";

// Delete a saved wheel preset.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const result = await deleteWheelTemplate(id);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json({ ok: true });
}
