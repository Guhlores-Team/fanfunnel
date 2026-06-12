import { NextResponse } from "next/server";
import { clearMyData } from "@/lib/data";
import { clientIp, rateLimitOr429 } from "@/lib/api/limit";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";

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
  const limited = rateLimitOr429(limitKey, 3, 60 * 60 * 1000);
  if (limited) return limited;

  let body: { confirm?: string };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  if (body.confirm !== "RESET") {
    return NextResponse.json({ error: "confirm_required" }, { status: 400 });
  }

  const result = await clearMyData();
  if ("error" in result) {
    const status = result.error === "unauthorized" ? 401 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json(result);
}
