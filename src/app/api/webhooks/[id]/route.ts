import { NextResponse } from "next/server";
import { deleteWebhook } from "@/lib/data";

// Delete one of the creator's registered webhooks.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const result = await deleteWebhook(id);
  if ("error" in result) {
    const status = result.error === "unauthorized" ? 401 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json({ ok: true });
}
