import { NextResponse } from "next/server";
import { getAutopilot, dismissAutopilotCard } from "@/lib/data";

// The creator's ranked action feed.
export async function GET() {
  const cards = await getAutopilot();
  return NextResponse.json({ cards });
}

// Dismiss or snooze a card. Body: { key, snoozeUntil? }.
export async function POST(req: Request) {
  let body: { key?: string; snoozeUntil?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body.key) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const result = await dismissAutopilotCard(body.key, body.snoozeUntil);
  if ("error" in result) {
    const status = result.error === "unauthorized" ? 401 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json(result);
}
