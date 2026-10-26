// Data layer — the signed-in creator's own account: profile prefs,
// onboarding state, brand colour and the full data reset.
import { isSupabaseConfigured, createClient } from "@/lib/supabase/server";
import {
  mockClearMyData,
  mockGetOnboardingDismissed,
  mockSetOnboardingDismissed,
  mockGetMyAccount,
  mockSetMyDisplayName,
  mockSetMyNotificationPrefs,
  mockSetActiveWheelBrandColor,
} from "./mock";
import { ensureWheelId, resolveActiveWheelId } from "./wheels";

/**
 * Wipe ALL of the signed-in creator's data — wheels, prizes, fans, links, spins,
 * grants, redemptions, campaigns, packs, templates, happy hours — leaving a
 * fresh account. Destructive and irreversible. Child rows cascade from the
 * parents below; we delete the creator-owned parents explicitly.
 */
export async function clearMyData(): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockClearMyData();
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  // fans → cascades fan_passes, spins, grants, messages, wishlists, referrals.
  // wheels → cascades prizes, (wheel-scoped) passes, happy_hours.
  // Then standalone creator-owned tables.
  const tables = [
    "fans",
    "wheels",
    "campaigns",
    "campaign_packs",
    "dm_templates",
    "prize_templates",
    "wheel_templates",
    "happy_hours",
    "webhooks",
    "autopilot_dismissals",
  ];
  for (const t of tables) {
    const { error } = await sb.from(t).delete().eq("creator_id", user.id);
    if (error) return { error: `db_error:${t}` };
  }

  // A true fresh start also resets profile preferences (via the SECURITY
  // DEFINER self-update RPCs — profiles_update RLS is admin-only): the
  // Get-started checklist comes back, and the public leaderboard returns to
  // its off default instead of silently staying live from before the reset.
  // Best-effort: a pref that fails to reset shouldn't fail the whole wipe.
  await Promise.allSettled([
    sb.rpc("set_onboarding_dismissed", { p_dismissed: false }),
    sb.rpc("set_leaderboard_enabled", { p_enabled: false }),
    sb.rpc("set_chat_settings", { p_intro: "", p_outro: "" }),
  ]);
  return { ok: true };
}

/** Whether the signed-in creator has dismissed the Get-started checklist. */
export async function getOnboardingDismissed(): Promise<boolean> {
  if (!isSupabaseConfigured()) return mockGetOnboardingDismissed();

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return false;

  const { data } = await sb
    .from("profiles")
    .select("onboarding_dismissed")
    .eq("id", user.id)
    .maybeSingle();
  return (data as { onboarding_dismissed: boolean } | null)?.onboarding_dismissed ?? false;
}

/** Persist the creator's Get-started checklist dismissal (account, not browser). */
export async function setOnboardingDismissed(
  dismissed: boolean
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockSetOnboardingDismissed(dismissed);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  const { error } = await sb.rpc("set_onboarding_dismissed", {
    p_dismissed: dismissed,
  });
  return error ? { error: "db_error" } : { ok: true };
}

// ---------------------------------------------------------------------------
// Account settings (Phase 9 #6): display name, email, notification prefs.
// profiles_update is admin-only, so self-updates go through the narrow
// SECURITY DEFINER RPCs added in migration 0025 (set_display_name,
// set_notification_prefs) — same pattern as set_public_profile / set_creator_note.
// ---------------------------------------------------------------------------

export interface NotificationPrefs {
  newSpin: boolean;
  lowBalance: boolean;
  messages: boolean;
}

export interface MyAccount {
  email: string | null;
  displayName: string | null;
  notifications: NotificationPrefs;
}

const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  newSpin: true,
  lowBalance: true,
  messages: true,
};

/** The signed-in creator's account settings (display name, email, notify prefs). */
export async function getMyAccount(): Promise<MyAccount> {
  if (!isSupabaseConfigured()) return mockGetMyAccount();
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) {
    return { email: null, displayName: null, notifications: { ...DEFAULT_NOTIFICATION_PREFS } };
  }
  const { data } = await sb
    .from("profiles")
    .select("display_name, notify_new_spin, notify_low_balance, notify_messages")
    .eq("id", user.id)
    .maybeSingle();
  const row = data as {
    display_name: string | null;
    notify_new_spin: boolean | null;
    notify_low_balance: boolean | null;
    notify_messages: boolean | null;
  } | null;
  return {
    email: user.email ?? null,
    displayName: row?.display_name ?? null,
    notifications: {
      newSpin: row?.notify_new_spin ?? true,
      lowBalance: row?.notify_low_balance ?? true,
      messages: row?.notify_messages ?? true,
    },
  };
}

/** Update only the creator's display name (self-update RPC). Blank is ignored. */
export async function setMyDisplayName(
  name: string
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockSetMyDisplayName(name);
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };
  const { error } = await sb.rpc("set_display_name", { p_name: name });
  return error ? { error: "db_error" } : { ok: true };
}

/** Update only the creator's notification preferences (self-update RPC). */
export async function setMyNotificationPrefs(
  prefs: NotificationPrefs
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockSetMyNotificationPrefs(prefs);
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };
  const { error } = await sb.rpc("set_notification_prefs", {
    p_new_spin: prefs.newSpin,
    p_low_balance: prefs.lowBalance,
    p_messages: prefs.messages,
  });
  return error ? { error: "db_error" } : { ok: true };
}

/**
 * Set the brand color of the creator's currently-active wheel. The public
 * /c/[slug] page derives its brand color from the active wheel, so this powers
 * the Settings → Public profile brand-color control (with a live preview).
 * wheels has a creator-scoped RW policy, so the auth client may write directly.
 */
export async function setActiveWheelBrandColor(
  color: string
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockSetActiveWheelBrandColor(color);
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };
  await ensureWheelId(sb, user.id);
  const wheelId = await resolveActiveWheelId(sb, user.id, new Date());
  if (!wheelId) return { error: "no_wheel" };
  const { error } = await sb
    .from("wheels")
    .update({ brand_color: color, updated_at: new Date().toISOString() })
    .eq("id", wheelId)
    .eq("creator_id", user.id);
  return error ? { error: "db_error" } : { ok: true };
}
