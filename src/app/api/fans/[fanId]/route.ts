import { NextResponse } from "next/server";
import { getFanDetail } from "@/lib/data";

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
