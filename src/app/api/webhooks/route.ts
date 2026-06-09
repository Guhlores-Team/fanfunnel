import { NextResponse } from "next/server";
import { listWebhooks, createWebhook } from "@/lib/data";

// A creator's outbound webhooks. Creator-scoped; newest first.
export async function GET() {
  const webhooks = await listWebhooks();
  return NextResponse.json({ webhooks });
}

export async function POST(req: Request) {
  let body: { url?: string; event?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const url = String(body.url ?? "").trim();
  if (!url || url.length > 2000) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const event = body.event ? String(body.event).slice(0, 80) : undefined;

  const result = await createWebhook(url, event);
  if ("error" in result) {
    const status = result.error === "unauthorized" ? 401 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json({ webhook: result });
}
