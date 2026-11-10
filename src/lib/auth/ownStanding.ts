// The caller's own account standing, for writes an UNAPPROVED account may
// make (the access request, the Terms): can_act_for / current_user_active
// refuse those accounts for not being approved, so the one fact that matters
// here (profiles.is_active) is read directly.
//
// Read on the SESSION client: profiles_select shows a session its own row.
// The profiles table is the only source: nothing user-editable is trusted.

interface OwnRowReader {
  from: (table: string) => unknown;
}

type OwnRowQuery = {
  select: (columns: string) => { eq: (column: string, value: string) => { maybeSingle: () => PromiseLike<{ data: unknown; error: unknown }> } };
};

/**
 * true only for a literal `is_active = true` on the caller's own row;
 * false = suspended; null = could not tell (no row, or the read failed), and
 * every caller refuses on anything but true.
 */
export async function ownAccountActive(session: OwnRowReader, userId: string): Promise<boolean | null> {
  try {
    const { data, error } = await (session.from("profiles") as OwnRowQuery).select("is_active").eq("id", userId).maybeSingle();
    if (error || !data) return null;
    const active = (data as { is_active?: unknown }).is_active;
    return active === true ? true : active === false ? false : null;
  } catch {
    return null;
  }
}

interface PermissionReader {
  rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
}

/**
 * The session may change its OWN creator settings: a literal true from
 * can_act_for(self, 'manage') (active, approved, second factor satisfied).
 *
 * The own-row setters (set_public_profile, set_creator_note,
 * set_chat_settings, set_leaderboard_enabled, set_pwa_icon_mode) answer a
 * suspended caller with no error and write nothing, so without this check the
 * dashboard would say "saved" for a change that never happened.
 */
export async function sessionMayManageSelf(session: PermissionReader, userId: string): Promise<boolean> {
  try {
    const { data, error } = await session.rpc("can_act_for", { target_creator: userId, perm: "manage" });
    return !error && data === true;
  } catch {
    return false;
  }
}
