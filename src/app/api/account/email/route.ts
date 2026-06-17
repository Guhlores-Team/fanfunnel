import { NextResponse } from "next/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { supabaseUrl } from "@/lib/supabase/url";
import { rateLimitOr429 } from "@/lib/api/limit";

// Change the signed-in creator's email via Supabase Auth. Supabase sends a
// confirmation link to the NEW address (and, per project settings, the old one);
// the change only takes effect once confirmed — so this endpoint just kicks off
// that flow. Validated + rate-limited; never used to read other users' emails.
//
// SECURITY (multi-review #1): require the current password (step-up reauth) before
// starting the change, so a hijacked or left-open session cannot move account
// ownership even if Supabase's secure-email-change setting is disabled. The check
// uses a throwaway, non-persisting client so the live session cookies are untouched.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: Request) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: "demo_mode" }, { status: 400 });
  }

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user || !user.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const limited = rateLimitOr429("emailchange:" + user.id, 5, 60 * 60 * 1000);
  if (limited) return limited;

  let body: { email?: unknown; currentPassword?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const currentPassword =
    typeof body.currentPassword === "string" ? body.currentPassword : "";
  if (!EMAIL.test(email) || email.length > 254) {
    return NextResponse.json({ error: "bad_email" }, { status: 400 });
  }
  if (email === (user.email ?? "").toLowerCase()) {
    return NextResponse.json({ error: "same_email" }, { status: 400 });
  }

  // Step-up reauth with the current password on a throwaway client (no cookie
  // writes → the live session is untouched even on success).
  const verifier = createSupabaseClient(
    supabaseUrl(),
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
  const { error: signInErr } = await verifier.auth.signInWithPassword({
    email: user.email,
    password: currentPassword,
  });
  if (signInErr) {
    return NextResponse.json({ error: "wrong_password" }, { status: 403 });
  }

  const { error } = await sb.auth.updateUser({ email });
  if (error) {
    return NextResponse.json({ error: "update_failed" }, { status: 400 });
  }

  // The new address must be confirmed via the emailed link before it applies.
  return NextResponse.json({ ok: true, pendingEmail: email });
}
