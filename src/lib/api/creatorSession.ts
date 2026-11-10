import { NextResponse } from "next/server";
import { hasSessionCookie } from "@/lib/api/limit";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";

/**
 * ATK-01 (widened): a creator (or an agency seat acting for them) legitimately
 * holds every fan's link token, and the fan's own-choice routes are
 * token-only. A consent-type action (age/Terms ack, leaderboard opt-in,
 * self-exclude, reward reveal, data export/delete) must come from the fan,
 * so a request that carries a creator session FOR THAT CREATOR is refused.
 *
 *   const refused = await refuseCreatorActingAsFan(req, pass.creatorId);
 *   if (refused) return refused;
 *
 * Fans have no session cookie, so the common path costs nothing. The role
 * source is server-controlled: the session's user id and the SECURITY DEFINER
 * can_act_for() (profiles / org_members), never a user-editable field. A failing auth
 * read never blocks a fan (the token stays the authority); it only fails to
 * refuse, which is the pre-existing behaviour.
 */
export async function refuseCreatorActingAsFan(req: Request, creatorId: string): Promise<NextResponse | null> {
  if (!hasSessionCookie(req) || !isSupabaseConfigured()) return null;
  try {
    const sb = await createClient();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return null;
    if (user.id === creatorId) return refusal();
    const { data } = await sb.rpc("can_act_for", { target_creator: creatorId, perm: "view" });
    return data === true ? refusal() : null;
  } catch {
    return null;
  }
}

/** 403 creator_session: the fan builder's routes turn this into their message. */
export function refusal(): NextResponse {
  return NextResponse.json({ error: "creator_session" }, { status: 403, headers: { "Cache-Control": "no-store" } });
}
