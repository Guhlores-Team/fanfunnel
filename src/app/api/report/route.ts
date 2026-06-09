import { NextResponse } from "next/server";
import { reportCreator } from "@/lib/data";
import { clientIp, rateLimitOr429 } from "@/lib/api/limit";

// A fan reports the creator behind their token (predatory / rule-breaking).
export async function POST(req: Request) {
  const limited = rateLimitOr429("report:" + clientIp(req), 5, 60_000);
  if (limited) return limited;

  let body: { token?: string; reason?: string; detail?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (
    typeof body.token !== "string" ||
    typeof body.reason !== "string" ||
    !body.token ||
    !body.reason ||
    (body.detail !== undefined && typeof body.detail !== "string")
  ) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const result = await reportCreator(body.token, body.reason, body.detail);
  if ("error" in result) {
    const status = result.error === "not_found" ? 404 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json(result);
}
