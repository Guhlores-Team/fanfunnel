import { NextResponse } from "next/server";
import { getWebhookSecret } from "@/lib/data/webhooks";
import { errorResponse } from "@/lib/api/handler";
import { NO_STORE_HEADERS } from "@/lib/privacy/respond";
import { limitRoute } from "@/lib/api/limit";

// The signed-in creator's webhook signing secret (A16). The data layer checks
// can_act_for(self, 'manage') on the caller's session before the service role
// reads webhook_secrets; the secret is never logged or cached.

// GET — show it (created on first use).
export async function GET(req: Request) {
  const rateLimited = await limitRoute(req, "webhooks/secret:GET");
  if (rateLimited) return rateLimited;
  const result = await getWebhookSecret();
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result, { headers: NO_STORE_HEADERS });
}

// POST — rotate it; deliveries are signed with the new one from now on.
export async function POST(req: Request) {
  const rateLimited = await limitRoute(req, "webhooks/secret:POST", "costly");
  if (rateLimited) return rateLimited;
  const result = await getWebhookSecret({ rotate: true });
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result, { headers: NO_STORE_HEADERS });
}
