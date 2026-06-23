import { NextResponse } from "next/server";
import { addWishlist, removeWishlist } from "@/lib/data";
import { clientIp, rateLimitOr429 } from "@/lib/api/limit";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";
import { ValidationError, str } from "@/lib/api/validate";

// A fan flags / un-flags a prize they're chasing. Token-gated (fans aren't authed).
export async function POST(req: Request) {
  return mutate(req, addWishlist);
}

export async function DELETE(req: Request) {
  return mutate(req, removeWishlist);
}

async function mutate(
  req: Request,
  fn: (token: string, prizeLabel: string) => Promise<{ ok: true } | { error: string }>
) {
  const body = await parseJsonBody<{ token?: string; prizeLabel?: string }>(req);
  if (body === BAD_REQUEST) return badRequest();

  let token: string;
  let prizeLabel: string;
  try {
    token = str(body.token, { max: 200, required: true })!;
    prizeLabel = str(body.prizeLabel, { max: 200, required: true })!;
  } catch (e) {
    if (e instanceof ValidationError) return badRequest(e.code);
    throw e;
  }

  // Per-fan write cap to stop unbounded wishlist churn (key on the fan token).
  const limited = rateLimitOr429("wish:" + token + ":" + clientIp(req), 30, 60_000);
  if (limited) return limited;

  const result = await fn(token, prizeLabel);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
