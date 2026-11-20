import { NextResponse } from "next/server";
import { listWebhooks, createWebhook } from "@/lib/data";
import { isWebhookEvent } from "@/lib/data/webhooks";
import { clientIp } from "@/lib/api/clientIp";
import { rateLimitOr429, limitRoute } from "@/lib/api/limit";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";

// A creator's outbound webhooks. Creator-scoped; newest first.
export async function GET(req: Request) {
  const rateLimited = await limitRoute(req, "webhooks:GET");
  if (rateLimited) return rateLimited;
  const webhooks = await listWebhooks();
  return NextResponse.json({ webhooks });
}

export async function POST(req: Request) {
  // Each create resolves DNS; cap how often one client can make us do that.
  const limited = await rateLimitOr429("webhook-create:" + clientIp(req), 10, 60_000);
  if (limited) return limited;

  const body = await parseJsonBody<{ url?: string; event?: string }>(req);
  if (body === BAD_REQUEST || !body || typeof body !== "object") return badRequest();

  const url = String(body.url ?? "").trim();
  if (!url || url.length > 2000) {
    return badRequest();
  }
  if (body.event !== undefined && !isWebhookEvent(body.event)) return badRequest("invalid_event");

  const result = await createWebhook(url, body.event);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json({ webhook: result });
}
