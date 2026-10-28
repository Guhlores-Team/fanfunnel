import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sha256Hex } from "@/lib/games/wheel/fairness";

/**
 * The irreversible part of deleting a creator account, shared by the admin
 * delete (POST /api/admin/account/delete) and the creator's own "Close my
 * account" (POST /api/account/close). Both callers have ALREADY:
 *   - authorized the caller (active admin on aal2 / the password step-up),
 *   - reserved the deletion through the last-admin guard RPC, which demotes an
 *     admin target to 'creator' as an atomic reservation.
 *
 * Removing the Supabase auth user cascades every tenant row (profiles.id →
 * auth.users ON DELETE CASCADE, every tenant table → profiles ON DELETE
 * CASCADE). Before that, the account's fan link tokens are collected so each
 * link can afterwards say "this creator has left" (link_tombstones keeps only
 * SHA-256 hashes, never the tokens).
 */
export type AccountDeletionClient = Pick<SupabaseClient, "auth" | "from">;

const PAGE = 1000;
const MAX_TOKENS = 100_000;

async function collectLinkTokens(svc: AccountDeletionClient, userId: string): Promise<string[]> {
  const tokens: string[] = [];
  for (let from = 0; from < MAX_TOKENS; from += PAGE) {
    const { data, error } = await svc
      .from("fan_passes")
      .select("token")
      .eq("creator_id", userId)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) break;
    const batch = (data ?? []) as { token: string }[];
    tokens.push(...batch.map((r) => r.token));
    if (batch.length < PAGE) break;
  }
  return tokens;
}

export async function deleteAccountAndTombstoneLinks(
  svc: AccountDeletionClient,
  userId: string,
  { wasAdmin }: { wasAdmin: boolean }
): Promise<{ ok: true; links: number } | { error: "delete_failed" }> {
  const tokens = await collectLinkTokens(svc, userId);

  const { error: delErr } = await svc.auth.admin.deleteUser(userId);
  if (delErr) {
    // The reservation demoted an admin target to hold the last-admin invariant
    // atomically. The delete failed, so restore the role — otherwise the
    // account is left altered without ever being deleted.
    if (wasAdmin) await svc.from("profiles").update({ role: "admin" }).eq("id", userId);
    return { error: "delete_failed" };
  }

  // Best effort: the account is already gone; a missing tombstone only means
  // that link shows the generic "not found" page instead of "creator left".
  for (let i = 0; i < tokens.length; i += 500) {
    const rows = await Promise.all(
      tokens.slice(i, i + 500).map(async (t) => ({ token_hash: await sha256Hex(t), reason: "creator_closed" }))
    );
    const { error } = await svc
      .from("link_tombstones")
      .upsert(rows, { onConflict: "token_hash", ignoreDuplicates: true });
    if (error) {
      console.error("deleteAccount: tombstones failed", error.message);
      break;
    }
  }
  return { ok: true, links: tokens.length };
}
