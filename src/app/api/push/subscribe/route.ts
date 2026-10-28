import { NextResponse } from "next/server";
import {
  addMyPushSubscription,
  getPushConfig,
  listMyPushDevices,
  pushAccountId,
  removeMyPushDevice,
  setMyPushDeviceDetails,
} from "@/lib/data";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";
import { clientIp } from "@/lib/api/clientIp";
import { rateLimitOr429 } from "@/lib/api/limit";
import { SUBSCRIBE_RATE_LIMIT } from "@/lib/push/config";

// Web push devices for the SIGNED-IN creator (migration 0056).
//   GET     list my devices (never endpoints or keys)
//   POST    { subscription }            register this browser
//   PATCH   { id, showDetails }         the per-device lock-screen switch (D9)
//   DELETE  { id }                      remove one of my devices
// Session client + RLS only. The account is ALWAYS auth.getUser(): a user_id
// (or any other field) in the body is ignored, so no request can list, add,
// change or remove another creator's devices.

const NO_STORE = { "Cache-Control": "private, no-store" };

export async function GET() {
  const result = await listMyPushDevices();
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result, { headers: NO_STORE });
}

export async function POST(req: Request) {
  // Keys unset: push is off, answered before any other work.
  if (!getPushConfig().available) return errorResponse("not_configured");
  // Per IP first (cheap, before any auth work), then per account.
  const byIp = await rateLimitOr429("push-sub-ip:" + clientIp(req), SUBSCRIBE_RATE_LIMIT.limit * 3, SUBSCRIBE_RATE_LIMIT.windowMs);
  if (byIp) return byIp;
  const account = await pushAccountId();
  if (!account) return errorResponse("unauthorized");
  const byAccount = await rateLimitOr429("push-sub:" + account, SUBSCRIBE_RATE_LIMIT.limit, SUBSCRIBE_RATE_LIMIT.windowMs);
  if (byAccount) return byAccount;

  const body = await parseJsonBody<{ subscription?: unknown }>(req);
  if (body === BAD_REQUEST || body === null || typeof body !== "object") return badRequest();
  const result = await addMyPushSubscription(body.subscription, req.headers.get("user-agent"));
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result, { status: 201, headers: NO_STORE });
}

export async function PATCH(req: Request) {
  const body = await parseJsonBody<{ id?: unknown; showDetails?: unknown }>(req);
  if (body === BAD_REQUEST || body === null || typeof body !== "object") return badRequest();
  const result = await setMyPushDeviceDetails(body.id, body.showDetails);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result, { headers: NO_STORE });
}

export async function DELETE(req: Request) {
  const body = await parseJsonBody<{ id?: unknown }>(req);
  if (body === BAD_REQUEST || body === null || typeof body !== "object") return badRequest();
  const result = await removeMyPushDevice(body.id);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
