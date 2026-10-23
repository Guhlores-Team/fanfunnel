import { NextResponse } from "next/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { supabaseUrl } from "@/lib/supabase/url";
import { rateLimitOr429 } from "@/lib/api/limit";
import { isAcceptablePassword } from "@/lib/api/password";

// Change the signed-in creator's password via Supabase Auth.
// Security:
//   • Re-authenticates with the CURRENT password first (defence against an
//     attacker on an open session / CSRF changing the password outright). The
//     check uses a throwaway, non-persisting client so it never disturbs the
//     real session cookies.
//   • Enforces a minimum length and a tight per-user rate limit.
//   • Never logs or echoes the passwords.
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

  const limited = await rateLimitOr429("pwchange:" + user.id, 5, 60 * 60 * 1000);
  if (limited) return limited;

  let body: { currentPassword?: unknown; newPassword?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const currentPassword =
    typeof body.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";

  // Shared policy: length floor + letter/digit mix (admin invite uses the same).
  if (!isAcceptablePassword(newPassword)) {
    return NextResponse.json({ error: "weak_password" }, { status: 400 });
  }

  // Re-auth with the current password on a throwaway client (persistSession:false
  // → no cookie writes, so the live session is untouched even on success).
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

  const { error } = await sb.auth.updateUser({ password: newPassword });
  if (error) {
    // Supabase rejects e.g. a password equal to the old one or too weak per the
    // project's policy. Surface a generic message; don't leak provider detail.
    return NextResponse.json({ error: "update_failed" }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
