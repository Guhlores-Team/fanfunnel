import { NextResponse } from "next/server";
import { deleteWheelTemplate } from "@/lib/data";

// Delete a saved wheel preset.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const result = await deleteWheelTemplate(id);
  if ("error" in result) {
    const status = result.error === "unauthorized" ? 401 : 400;
    return NextResponse.json(result, { status });
  }
  return NextResponse.json({ ok: true });
}
