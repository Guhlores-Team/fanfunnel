import { NextResponse } from "next/server";
import { BAD_REQUEST, badRequest, parseJsonBody } from "@/lib/api/handler";
import { rateLimitOr429 } from "@/lib/api/limit";
import { isAcceptablePassword } from "@/lib/api/password";
import { aalFromAccessToken, hasVerifiedFactor, openedByRecentLink } from "@/lib/auth/assurance";
import { mfaStepUpResponse, verifyCurrentPassword } from "@/lib/auth/stepUp";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { signOutOtherSessions } from "@/lib/auth/sessions";

// The new-password screens (/reset-password, /set-password) set the password
// through here, never with updateUser() from the browser (WU-06, WU-07).
//
// Security:
//   • A session an e-mail link opened recently (amr "recovery"/"invite", the
//     Auth server's signed claim) may set a password without the current one:
//     that is what the link proved. Any other session must give the current
//     password, checked on a throwaway client like /api/account/password.
//   • A two-factor account must have entered its code in THIS session (aal2)
//     first; the screen shows the code step on `mfa_required` instead of the
//     provider's "AAL2 session is required" (WU-07).
//   • With no body fields the route only reports what the session still needs
//     (`requires`), so the screen can ask for it before the creator types.
//   • Afterwards every other session of the account is signed out (WG-16).
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

  const {
    data: { session },
  } = await sb.auth.getSession();
  const token = session?.access_token;
  if (hasVerifiedFactor(user)) {
    const step = mfaStepUpResponse({ aal: aalFromAccessToken(token), hasVerifiedFactor: true });
    if (step) return step;
  }

  const limited = await rateLimitOr429("pwreset:" + user.id, 10, 60 * 60 * 1000);
  if (limited) return limited;

  const body = await parseJsonBody<{ newPassword?: unknown; currentPassword?: unknown }>(req);
  if (body === BAD_REQUEST) return badRequest();
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";

  const byLink = openedByRecentLink(token);
  if (!byLink && !currentPassword) {
    return NextResponse.json({ error: "current_password_required", requires: "current_password" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  if (!newPassword) {
    // A probe: the session may set a password now.
    return NextResponse.json({ ok: true, requires: "none", byLink }, { headers: { "Cache-Control": "no-store" } });
  }
  if (!isAcceptablePassword(newPassword)) {
    return NextResponse.json({ error: "weak_password" }, { status: 400 });
  }
  if (!byLink && !(await verifyCurrentPassword(user.email, currentPassword))) {
    return NextResponse.json({ error: "wrong_password" }, { status: 403 });
  }

  const { error } = await sb.auth.updateUser({ password: newPassword });
  if (error) {
    const code = (error as { code?: string }).code;
    if (code === "insufficient_aal") return NextResponse.json({ error: "mfa_required", step: "challenge" }, { status: 403 });
    if (code === "same_password") return NextResponse.json({ error: "same_password" }, { status: 400 });
    if (code === "weak_password") return NextResponse.json({ error: "weak_password" }, { status: 400 });
    return NextResponse.json({ error: "update_failed" }, { status: 400 });
  }

  const othersSignedOut = await signOutOtherSessions(sb);
  return NextResponse.json({ ok: true, othersSignedOut });
}
