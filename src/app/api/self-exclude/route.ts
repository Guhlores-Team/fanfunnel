import { NextResponse } from "next/server";
import { selfExclude } from "@/lib/data";

// A fan pauses their own spin link. Body: { token }.
export async function POST(req: Request) {
  let body: { token?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body.token) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const result = await selfExclude(body.token);
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json(result);
}
