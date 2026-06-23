import { NextResponse } from "next/server";
import { deletePrizeTemplate } from "@/lib/data";
import { errorResponse } from "@/lib/api/handler";

// Delete a saved prize preset.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const result = await deletePrizeTemplate(id);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json({ ok: true });
}
