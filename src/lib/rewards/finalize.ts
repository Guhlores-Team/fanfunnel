import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { openReward } from "./crypto";
import type { DeliveredReward } from "./config";
import type { Json } from "@/lib/data/db.types";

type SealedCandidate = { delivery: "link" | "text" | "codes"; codeId?: string; cipher: string; iv: string; keyVersion: number };
export type InstantFinalization =
  | { status: "recorded"; id: string; shareId: string; reward: DeliveredReward; stockAfter: number | null }
  | { status: "unavailable" | "failed" | "pending" };

/** One UUID, one transaction and one immutable receipt, including timeout retries. */
export async function finalizeInstantSpin(
  sb: ReturnType<typeof createServiceClient>,
  spin: Record<string, unknown>,
  delivery: "link" | "text" | "codes",
  creatorId: string,
): Promise<InstantFinalization> {
  for (let candidateAttempt = 0; candidateAttempt < 20; candidateAttempt++) {
    let candidate: SealedCandidate;
    if (delivery === "codes") {
      const { data, error } = await sb.from("prize_reward_codes")
        .select("id, cipher, iv, key_version").eq("prize_id", String(spin.prize_id)).eq("creator_id", creatorId).is("spin_id", null)
        .order("created_at", { ascending: true }).order("id", { ascending: true }).limit(1).maybeSingle();
      if (error) return { status: "failed" };
      const row = data as { id: string; cipher: string; iv: string; key_version: number } | null;
      if (!row) return { status: "unavailable" };
      candidate = { delivery, codeId: row.id, cipher: row.cipher, iv: row.iv, keyVersion: row.key_version };
    } else {
      const { data, error } = await sb.from("prize_rewards").select("kind, cipher, iv, key_version")
        .eq("prize_id", String(spin.prize_id)).eq("creator_id", creatorId).maybeSingle();
      if (error) return { status: "failed" };
      const row = data as { kind: string; cipher: string; iv: string; key_version: number } | null;
      if (!row || row.kind !== delivery) return { status: "unavailable" };
      candidate = { delivery, cipher: row.cipher, iv: row.iv, keyVersion: row.key_version };
    }
    try { openReward(candidate, creatorId); }
    catch { return { status: "unavailable" }; }

    let reply: unknown;
    let confirmed = false;
    for (let transportAttempt = 0; transportAttempt < 3; transportAttempt++) {
      try {
        const { data, error } = await sb.rpc("finalize_reward_spin", {
          p_spin: spin as Json,
          p_expected: candidate as unknown as Json,
        });
        if (error) {
          // SQLSTATE means Postgres rejected and rolled back the statement.
          // Transport/PostgREST failures can conceal a committed transaction.
          if (error.code && /^[0-9A-Z]{5}$/.test(error.code) && !error.code.startsWith("PGRST")) return { status: "failed" };
          continue;
        }
        reply = data;
        confirmed = true;
        break;
      } catch { /* Retry the SAME UUID; never allocate a second winner. */ }
    }
    if (!confirmed) return { status: "pending" };
    const result = reply as { status?: string; id?: string; shareId?: string; reward?: { kind: DeliveredReward["kind"]; cipher: string; iv: string; keyVersion: number }; stockAfter?: number | null } | null;
    if (result?.status === "retry") continue;
    if (result?.status === "sold_out" || result?.status === "unavailable") return { status: "unavailable" };
    if (result?.status === "changed") return { status: "failed" };
    if (result?.status !== "recorded" || !result.id || !result.shareId || !result.reward) return { status: "pending" };
    try {
      const value = openReward(result.reward, creatorId);
      return { status: "recorded", id: result.id, shareId: result.shareId,
        reward: { kind: result.reward.kind, value }, stockAfter: result.stockAfter ?? null };
    } catch {
      // A durable win may exist. Do not refund a potentially delivered code.
      return { status: "pending" };
    }
  }
  return { status: "failed" }; // Contention is a retryable failure, not altered odds.
}
