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
//   • A session an e-mail link or e-mail code opened in the last hour (amr
//     `otp` / `recovery` / `invite` / `magiclink`, the Auth server's signed
//     claim; `openedByRecentLink`) may set a password without the current
//     one: that is what the link proved. Any other session (a password
//     sign-in, with or without a two-factor code) must give the current
//     password, checked on a throwaway client like /api/account/password.
//   • A two-factor account must have entered its code in THIS session (aal2)
//     first; the screen shows the code step on `mfa_required` instead of the
//     provider's "AAL2 session is required" (WU-07). This comes before the
//     link rule, so a link alone never changes a two-factor account.
//   • With no `newPassword` the route only reports what the session still
//     needs (`requires`) and whose session it is (`email`, from getUser()), so
//     the screen can ask for it before the creator types. Probes have their
//     own generous limit; only real attempts spend the reset budget (A9).
//   • Afterwards every other session of the account is signed out (WG-16).

/** Password attempts per account and hour (a wrong current password counts). */
export const RESET_ATTEMPT_LIMIT = { limit: 10, windowMs: 60 * 60 * 1000 } as const;
/** "What does this session need?" questions: each page load and each code step asks once. */
export const RESET_PROBE_LIMIT = { limit: 120, windowMs: 60 * 60 * 1000 } as const;

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

  const body = await parseJsonBody<{ newPassword?: unknown; currentPassword?: unknown }>(req);
  if (body === BAD_REQUEST) return badRequest();
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";

  // A9: the screen's empty-body probe must not use up the attempts.
  const limited = newPassword
    ? await rateLimitOr429("pwreset:" + user.id, RESET_ATTEMPT_LIMIT.limit, RESET_ATTEMPT_LIMIT.windowMs)
    : await rateLimitOr429("pwreset-probe:" + user.id, RESET_PROBE_LIMIT.limit, RESET_PROBE_LIMIT.windowMs);
  if (limited) return limited;

  const byLink = openedByRecentLink(token);
  if (!byLink && !currentPassword) {
    return NextResponse.json(
      { error: "current_password_required", requires: "current_password", email: user.email },
      { status: 403, headers: { "Cache-Control": "no-store" } }
    );
  }
  if (!newPassword) {
    // A probe: the session may set a password now.
    return NextResponse.json({ ok: true, requires: "none", byLink, email: user.email }, { headers: { "Cache-Control": "no-store" } });
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
