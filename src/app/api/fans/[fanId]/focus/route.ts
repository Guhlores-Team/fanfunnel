import { NextResponse } from "next/server";
import { getCreatorFocus, grantFocusPack, cancelFanFocus } from "@/lib/data";
import { BAD_REQUEST, parseJsonBody } from "@/lib/api/handler";
type Context = { params: Promise<{ fanId: string }> };
const json = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: { "Cache-Control": "no-store" } });
function respond(result: Awaited<ReturnType<typeof getCreatorFocus>> | Awaited<ReturnType<typeof grantFocusPack>> | Awaited<ReturnType<typeof cancelFanFocus>>) {
  if (!("error" in result)) return json(result);
  return json(result, result.error === "unauthorized" ? 401 : result.error === "forbidden" ? 403 : result.error === "not_found" ? 404 : result.error === "bad_request" ? 400 : 409);
}
export async function GET(_req: Request, context: Context) { return respond(await getCreatorFocus((await context.params).fanId)); }
export async function POST(req: Request, context: Context) {
  const body = await parseJsonBody<Record<string, unknown>>(req);
  if (body === BAD_REQUEST || !body || !["requestId", "packId", "prizeId", "passId"].every(key => typeof body[key] === "string")) return json({ error: "bad_request" }, 400);
  // Ignore client price/multiplier/credit fields. The RPC reads the stored pack and prize.
  return respond(await grantFocusPack((await context.params).fanId, { requestId: String(body.requestId), packId: String(body.packId), prizeId: String(body.prizeId), passId: String(body.passId) }));
}
export async function DELETE(req: Request, context: Context) {
  const body = await parseJsonBody<{ focusId?: unknown }>(req);
  if (body === BAD_REQUEST || !body || typeof body.focusId !== "string") return json({ error: "bad_request" }, 400);
  return respond(await cancelFanFocus((await context.params).fanId, body.focusId));
}
