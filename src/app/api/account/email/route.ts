import { NextResponse } from "next/server";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { rateLimitOr429 } from "@/lib/api/limit";

// Change the signed-in creator's email via Supabase Auth. Supabase sends a
// confirmation link to the NEW address (and, per project settings, the old one);
// the change only takes effect once confirmed — so this endpoint just kicks off
// that flow. Validated + rate-limited; never used to read other users' emails.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: Request) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: "demo_mode" }, { status: 400 });
  }

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const limited = rateLimitOr429("emailchange:" + user.id, 5, 60 * 60 * 1000);
  if (limited) return limited;

  let body: { email?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!EMAIL.test(email) || email.length > 254) {
    return NextResponse.json({ error: "bad_email" }, { status: 400 });
  }
  if (email === (user.email ?? "").toLowerCase()) {
    return NextResponse.json({ error: "same_email" }, { status: 400 });
  }

  const { error } = await sb.auth.updateUser({ email });
  if (error) {
    return NextResponse.json({ error: "update_failed" }, { status: 400 });
  }

  // The new address must be confirmed via the emailed link before it applies.
  return NextResponse.json({ ok: true, pendingEmail: email });
}
