import { NextResponse } from "next/server";
import { ackFan } from "@/lib/data";
import { clientIp, rateLimitOr429 } from "@/lib/api/limit";

// A fan acknowledges the age-gate / ToS. Token-gated (fans aren't authed).
export async function POST(req: Request) {
  const limited = rateLimitOr429("ack:" + clientIp(req), 20, 60_000);
  if (limited) return limited;

  let body: { token?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (typeof body.token !== "string" || !body.token) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const result = await ackFan(body.token);
  if ("error" in result) {
    const status = result.error === "not_found" ? 404 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json(result);
}
