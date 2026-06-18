import { NextResponse } from "next/server";
import { sendCreatorMessage } from "@/lib/data";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { clientIp, rateLimitOr429 } from "@/lib/api/limit";

// The creator replies to a fan in the drawer/inbox (RLS-scoped).
export async function POST(req: Request) {
  let body: { fanId?: string; body?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body.fanId || typeof body.body !== "string") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  // Cap message length to prevent storage bloat and expensive reads (matches fan messages).
  // Validate the trimmed length up front so a whitespace-only or non-string body
  // can't reach sendCreatorMessage and throw on body.trim().
  const trimmed = body.body.trim();
  if (trimmed.length < 1 || trimmed.length > 2000) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
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
  const result = await sendCreatorMessage(body.fanId, body.body);
  if ("error" in result) {
    const status = result.error === "unauthorized" ? 401 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json(result);
}
