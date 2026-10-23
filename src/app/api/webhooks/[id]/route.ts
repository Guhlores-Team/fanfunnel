import { NextResponse } from "next/server";
import { deleteWebhook } from "@/lib/data";
import { errorResponse } from "@/lib/api/handler";

// Delete one of the creator's registered webhooks.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const result = await deleteWebhook(id);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json({ ok: true });
}
