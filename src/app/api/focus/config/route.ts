import { NextResponse } from "next/server";
import { getFocusConfig } from "@/lib/data";
export async function GET() {
  const result = await getFocusConfig();
  return NextResponse.json(result, { status: "error" in result ? result.error === "unauthorized" ? 401 : result.error === "forbidden" ? 403 : 503 : 200,
    headers: { "Cache-Control": "no-store" } });
}
