import { NextResponse } from "next/server";
import { createPass } from "@/lib/data";

// Creates a unique, working fan pass and returns its token. The creator's
// dashboard calls this so every generated link genuinely opens and spins.
export async function POST(req: Request) {
  let body: { name?: string; spins?: number; fanId?: string; wheelId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await createPass({
    name: String(body.name ?? "").slice(0, 80),
    spins: Number(body.spins ?? 0),
    fanId: body.fanId,
    wheelId: body.wheelId,
  });

  if ("error" in result) {
    const status = result.error === "unauthorized" ? 401 : 400;
    return NextResponse.json(result, { status });
  }
  return NextResponse.json(result);
}
