import { NextResponse } from "next/server";
import { getFanDetail, deleteFan } from "@/lib/data";

// A single fan account's full detail, for the creator's fan drill-in.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ fanId: string }> }
) {
  const { fanId } = await params;
  const detail = await getFanDetail(fanId);
  if (!detail) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(detail);
}

// Permanently delete a fan account (cascades its links, grants; anonymizes spins).
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ fanId: string }> }
) {
  const { fanId } = await params;
  const result = await deleteFan(fanId);
  if ("error" in result) {
    const status = result.error === "unauthorized" ? 401 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json({ ok: true });
}
