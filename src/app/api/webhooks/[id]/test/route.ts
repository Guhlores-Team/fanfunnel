import { NextResponse } from "next/server";
import { sendTestWebhook } from "@/lib/data";
import { errorResponse } from "@/lib/api/handler";
import { limitRoute } from "@/lib/api/limit";

// PR-15: send one signed sample delivery to one of the creator's webhooks and
// report the receiver's HTTP status ({ ok, status, signed, event }; status 0
// means no answer). Rate-limited per creator inside sendTestWebhook.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const rateLimited = await limitRoute(req, "webhooks/[id]/test:POST", "costly");
  if (rateLimited) return rateLimited;
  const { id } = await params;
  if (typeof id !== "string" || id.length > 64) return errorResponse("not_found");
  const result = await sendTestWebhook(id);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
