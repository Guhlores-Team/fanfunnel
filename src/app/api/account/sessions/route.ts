import { NextResponse } from "next/server";
import { creatorMfaStepUpResponse } from "@/lib/auth/stepUp";
import { rateLimitOr429 } from "@/lib/api/limit";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { signOutOtherSessions } from "@/lib/auth/sessions";

// "Sign out everywhere else" (WG-16 / WU-20): ends every other session of the
// signed-in account and keeps this one. Same gate as the other account
// actions: a real session (getUser), the two-factor step for an enrolled
// account, and the proxy's same-origin check for /api writes. No password is
// asked: the action only ever removes access, never grants it.
export async function POST() {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: "demo_mode" }, { status: 400 });
  }
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const step = await creatorMfaStepUpResponse(sb, user);
  if (step) return step;

  const limited = await rateLimitOr429("signout-others:" + user.id, 10, 60 * 60 * 1000);
  if (limited) return limited;

  const ok = await signOutOtherSessions(sb);
  if (!ok) return NextResponse.json({ error: "signout_failed" }, { status: 502 });
  return NextResponse.json({ ok: true });
}
