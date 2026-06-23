import { NextResponse } from "next/server";
import { listWebhooks, createWebhook } from "@/lib/data";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";

// A creator's outbound webhooks. Creator-scoped; newest first.
export async function GET() {
  const webhooks = await listWebhooks();
  return NextResponse.json({ webhooks });
}

export async function POST(req: Request) {
  const body = await parseJsonBody<{ url?: string; event?: string }>(req);
  if (body === BAD_REQUEST) return badRequest();

  const url = String(body.url ?? "").trim();
  if (!url || url.length > 2000) {
    return badRequest();
  }
  const event = body.event ? String(body.event).slice(0, 80) : undefined;

  const result = await createWebhook(url, event);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json({ webhook: result });
}
