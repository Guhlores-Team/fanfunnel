import { NextResponse } from "next/server";
import { setFanBlocked } from "@/lib/data";

// Creator blocks/unblocks a fan. Body: { blocked: boolean }.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ fanId: string }> }
) {
  const { fanId } = await params;
  let body: { blocked?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (typeof body.blocked !== "boolean") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const result = await setFanBlocked(fanId, body.blocked);
  if ("error" in result) {
    const status = result.error === "unauthorized" ? 401 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json(result);
}
