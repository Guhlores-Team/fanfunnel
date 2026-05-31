import { NextResponse } from "next/server";
import { reportCreator } from "@/lib/data";

// A fan reports the creator behind their token (predatory / rule-breaking).
export async function POST(req: Request) {
  let body: { token?: string; reason?: string; detail?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body.token || !body.reason) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const result = await reportCreator(body.token, body.reason, body.detail);
  if ("error" in result) {
    const status = result.error === "not_found" ? 404 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json(result);
}
