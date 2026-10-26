// Data layer — referral economy views.
import { isSupabaseConfigured, createServiceClient, createClient } from "@/lib/supabase/server";
import type { ReferralOverview } from "./types";
import { mockGetReferralOverview, mockGetReferralStats } from "./mock";
import { REFERRAL_BONUS, REFERRAL_CAP } from "./shared";

// --- Referral ---------------------------------------------------------------

export async function getReferralOverview(
  token: string
): Promise<ReferralOverview> {
  if (!isSupabaseConfigured())
    return (
      mockGetReferralOverview(token) ?? {
        code: "",
        referredCount: 0,
        creditedCount: 0,
        cap: REFERRAL_CAP,
        bonusPerReferral: REFERRAL_BONUS,
      }
    );

  const sb = createServiceClient();
  const { data: passData } = await sb
    .from("fan_passes")
    .select("fan:fans(id, referral_code)")
    .eq("token", token)
    .eq("is_active", true)
    .maybeSingle();
  const fan = (passData as unknown as {
    fan: { id: string; referral_code: string | null } | null;
  } | null)?.fan;

  const base = {
    code: fan?.referral_code ?? "",
    referredCount: 0,
    creditedCount: 0,
    cap: REFERRAL_CAP,
    bonusPerReferral: REFERRAL_BONUS,
  };
  if (!fan) return base;

  const { count: referredCount } = await sb
    .from("referrals")
    .select("id", { count: "exact", head: true })
    .eq("referrer_fan_id", fan.id);
  const { count: creditedCount } = await sb
    .from("referrals")
    .select("id", { count: "exact", head: true })
    .eq("referrer_fan_id", fan.id)
    .not("credited_at", "is", null);

  return {
    ...base,
    referredCount: referredCount ?? 0,
    creditedCount: creditedCount ?? 0,
  };
}

export async function getReferralStats(): Promise<{
  referredCount: number;
  creditedCount: number;
  bonusAwarded: number;
}> {
  if (!isSupabaseConfigured()) return mockGetReferralStats();

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { referredCount: 0, creditedCount: 0, bonusAwarded: 0 };

  const { data } = await sb
    .from("referrals")
    .select("credited_at, bonus_spins")
    .eq("creator_id", user.id);
  const rows = (data ?? []) as {
    credited_at: string | null;
    bonus_spins: number;
  }[];

  const referredCount = rows.length;
  const credited = rows.filter((r) => r.credited_at !== null);
  const creditedCount = credited.length;
  // Both parties receive bonus_spins per credited referral.
  const bonusAwarded = credited.reduce((s, r) => s + r.bonus_spins * 2, 0);
  return { referredCount, creditedCount, bonusAwarded };
}
