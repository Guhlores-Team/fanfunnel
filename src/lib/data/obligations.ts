import "server-only";
import { isSupabaseConfigured, createClient } from "@/lib/supabase/server";
import { CompleteReadError } from "./readPages";
import { isMissingRpc } from "./shared";
import { getOverview } from "./analytics";
import { listFans } from "./fans";
import { mockGetOverview, mockListFans } from "./mock";
import { obligationsFrom, type CreatorObligations } from "./obligationsShape";
export { obligationsFrom, type CreatorObligations } from "./obligationsShape";


export async function getCreatorObligations(): Promise<CreatorObligations | null> {
  if (!isSupabaseConfigured()) return obligationsFrom(mockGetOverview(), mockListFans());
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return null;
  const { data, error } = await sb.rpc("creator_obligations", { p_creator: user.id });
  if (error && !isMissingRpc(error)) throw new CompleteReadError();
  if (!error && data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    const n = (key: string) => (typeof o[key] === "number" ? (o[key] as number) : Number(o[key] ?? 0) || 0);
    return {
      prizes: n("openPrizes"),
      fans: n("fansOwed"),
      fansAtLeast: false,
      paidSpins: n("unplayedPaidSpins"),
      payingFans: n("fansWithCredit"),
      unplayedSpins: n("unplayedSpins"),
      activeLinks: n("activeLinks"),
    };
  }
  const [overview, fans] = await Promise.all([getOverview(), listFans()]);
  return obligationsFrom(overview, fans);
}
