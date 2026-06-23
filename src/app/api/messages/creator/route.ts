import { NextResponse } from "next/server";
import { sendCreatorMessage } from "@/lib/data";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { clientIp, rateLimitOr429 } from "@/lib/api/limit";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";
import { ValidationError, str } from "@/lib/api/validate";

// The creator replies to a fan in the drawer/inbox (RLS-scoped).
export async function POST(req: Request) {
  const body = await parseJsonBody<{ fanId?: string; body?: string }>(req);
  if (body === BAD_REQUEST) return badRequest();

  let fanId: string;
  let text: string;
  try {
    fanId = str(body.fanId, { max: 200, required: true })!;
    text = str(body.body, { max: 2000, required: true })!;
  } catch (e) {
    if (e instanceof ValidationError) return badRequest(e.code);
    throw e;
  }

  // Per-creator send cap to stop a creator session from flooding replies
  // (matches the fan route). Keyed on the authenticated creator id when the
  // real backend is configured; falls back to the client IP in demo/mock mode.
  let rlKey = clientIp(req);
  if (isSupabaseConfigured()) {
    const sb = await createClient();
    const {
      data: { user },
    } = await sb.auth.getUser();
    if (user) rlKey = user.id;
  }
  const limited = rateLimitOr429("creatormsg:" + rlKey, 10, 60_000);
  if (limited) return limited;

  const result = await sendCreatorMessage(fanId, text);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
