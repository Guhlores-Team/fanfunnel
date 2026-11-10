import { NextResponse } from "next/server";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { isCrossOriginWrite } from "@/lib/security/sameOrigin";

// RS-10: this route is outside /api/, so the proxy's I4 origin check never
// runs for it. The same check runs here (the shared helper scopes itself to
// /api/ paths, hence the spelling), so a cross-site form cannot log a creator
// out; the sign-out itself stays a plain form POST (no script needed).
export async function POST(req: Request) {
  if (
    isCrossOriginWrite({
      method: req.method,
      path: "/api/auth/signout",
      headers: req.headers,
      allowedOrigins: [process.env.NEXT_PUBLIC_SITE_URL],
      onVercel: process.env.VERCEL === "1",
    })
  ) {
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  if (isSupabaseConfigured()) {
    const sb = await createClient();
    await sb.auth.signOut();
  }
  return NextResponse.redirect(new URL("/login", req.url), { status: 303 });
}
