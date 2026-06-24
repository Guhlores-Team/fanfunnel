import { NextResponse } from "next/server";
import { clearMyData } from "@/lib/data";
import { clientIp, rateLimitOr429 } from "@/lib/api/limit";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { badRequest, errorResponse, parseJsonBody, BAD_REQUEST } from "@/lib/api/handler";

// Wipe ALL of the signed-in creator's data (wheels, fans, spins, campaigns…).
// Destructive, so beyond the client's double-confirm we require the literal
// "RESET" phrase in the body server-side (defeats a stray CSRF/XSS POST) and
// hard-limit how often this can run.
export async function POST(req: Request) {
  // Prefer keying the limit on the authenticated user (an IP key is shared
  // behind NAT and rotatable); fall back to IP in demo/mock mode.
  let limitKey = "reset:ip:" + clientIp(req);
  if (isSupabaseConfigured()) {
    const sb = await createClient();
    const {
      data: { user },
    } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    limitKey = "reset:user:" + user.id;
  }
  const limited = await rateLimitOr429(limitKey, 3, 60 * 60 * 1000);
  if (limited) return limited;

  const parsed = await parseJsonBody<{ confirm?: string }>(req);
  const body = parsed === BAD_REQUEST ? {} : parsed;
  if (body.confirm !== "RESET") {
    return badRequest("confirm_required");
  }

  const result = await clearMyData();
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
