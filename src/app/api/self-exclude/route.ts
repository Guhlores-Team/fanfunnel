import { NextResponse } from "next/server";
import { selfExclude } from "@/lib/data";
import { clientIp, rateLimitOr429 } from "@/lib/api/limit";

// A fan pauses their own spin link. Body: { token }.
export async function POST(req: Request) {
  const limited = rateLimitOr429("selfexclude:" + clientIp(req), 10, 60_000);
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
  const result = await selfExclude(body.token);
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json(result);
}
