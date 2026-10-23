import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Auth redirect target for email links (password recovery, and any future
// confirm/magic-link). Supabase appends `?code=...` (PKCE); we exchange it for a
// session — the code-verifier cookie set by the browser client when the email
// was requested travels here, so the exchange completes server-side — then send
// the user on to `next` (e.g. /reset-password) now that they're authenticated.
export async function GET(req: Request) {
  const { searchParams, origin } = new URL(req.url);
  const code = searchParams.get("code");
  // Only allow same-origin relative paths as `next` to avoid open-redirects.
  const nextParam = searchParams.get("next") || "/dashboard";
  const next = nextParam.startsWith("/") ? nextParam : "/dashboard";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}${next}`);
  }

  return NextResponse.redirect(`${origin}/login?error=auth_link`);
}
