import { NextResponse } from "next/server";
import { createServiceClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { limitRoute } from "@/lib/api/limit";
import { NO_STORE_HEADERS } from "@/lib/privacy/respond";

// OPS-02: what an external uptime monitor polls. The home page is served from
// the CDN cache, so it stays green while the database is down; this answers
// from the server every time: 200 {ok:true} when the database replies to the
// service-only schema_version() RPC within HEALTH_TIMEOUT_MS, else 503
// {ok:false}. The body never says why (no versions, codes or hosts).
export const HEALTH_TIMEOUT_MS = 2_000;

const reply = (body: Record<string, unknown>, status: number) => NextResponse.json(body, { status, headers: NO_STORE_HEADERS });

export async function GET(req: Request) {
  const limited = await limitRoute(req, "health:GET", "costly");
  if (limited) {
    limited.headers.set("Cache-Control", "no-store");
    return limited;
  }
  try {
    // OPS3-01: a misconfigured Production (isSupabaseConfigured throws when a
    // required key is missing) is "down" to the monitor: 503, never a 500.
    if (!isSupabaseConfigured()) return reply({ ok: true, mode: "demo" }, 200);
    const { error } = await createServiceClient().rpc("schema_version").abortSignal(AbortSignal.timeout(HEALTH_TIMEOUT_MS));
    return error ? reply({ ok: false }, 503) : reply({ ok: true }, 200);
  } catch {
    return reply({ ok: false }, 503);
  }
}
