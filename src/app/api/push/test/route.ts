import { NextResponse } from "next/server";
import { getPushConfig, pushAccountId, sendMyTestPush } from "@/lib/data";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";
import { clientIp } from "@/lib/api/clientIp";
import { rateLimitOr429 } from "@/lib/api/limit";
import { TEST_RATE_LIMIT } from "@/lib/push/config";

// "Send a test" from Settings › Notifications: a fixed test notification to the
// signed-in creator's OWN devices (optionally one, by id). Only devices the
// session can see through RLS are targeted; the text is fixed, never from the
// request. Rate-limited per account and per IP.
export async function POST(req: Request) {
  // Keys unset: push is off, answered before any other work.
  if (!getPushConfig().available) return errorResponse("not_configured");
  const byIp = await rateLimitOr429("push-test-ip:" + clientIp(req), TEST_RATE_LIMIT.limit * 3, TEST_RATE_LIMIT.windowMs);
  if (byIp) return byIp;
  const account = await pushAccountId();
  if (!account) return errorResponse("unauthorized");
  const byAccount = await rateLimitOr429("push-test:" + account, TEST_RATE_LIMIT.limit, TEST_RATE_LIMIT.windowMs);
  if (byAccount) return byAccount;

  const body = await parseJsonBody<{ id?: unknown }>(req);
  if (body === BAD_REQUEST || body === null || typeof body !== "object") return badRequest();
  const result = await sendMyTestPush(body.id);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
