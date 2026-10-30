// Data layer — referral economy views.
import { isSupabaseConfigured, createClient } from "@/lib/supabase/server";
import { mockGetReferralStats } from "./mock";

// --- Referral ---------------------------------------------------------------

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
