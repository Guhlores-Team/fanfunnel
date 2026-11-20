// OPS-04: Admin › "Look up a win". A support complaint ("my prize never
// came") arrives with the fan's verify link; this answers it without raw SQL
// on LIVE. Read-only, service role, called ONLY from the admin route after
// requireAdminRoute() (is_admin() + aal2). Returns the facts support needs and
// nothing that identifies or reaches the fan: no pass token, no fan id or
// name, no reward code, no seeds.
import { createServiceClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { isShareIdShape } from "./rewards";
import { mockAdminLookupWin } from "./mock";

export interface AdminWinLookup {
  shareId: string;
  at: string;
  prize: string;
  rarity: string;
  gameKind: string;
  kind: string;
  /** status: the approval state, "suspended", or "deleted" when the account is gone. */
  creator: { id: string | null; title: string | null; status: string | null };
  redemption: { status: string; createdAt: string; fulfilledAt: string | null } | null;
  /** The fan deleted their data (the spin is kept, anonymized). */
  fanDeleted: boolean;
}

/** A pasted verify/share link (absolute or relative) or a bare share id → the id, else null. */
export function parseWinReference(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text || text.length > 512) return null;
  const m = /(?:^|\/)(?:verify|share)\/([^/?#\s]+)\/?(?:[?#].*)?$/.exec(text);
  const id = m ? m[1] : text;
  return isShareIdShape(id) ? id : null;
}

type SpinRow = {
  id: string; share_id: string; created_at: string; prize_label: string; prize_rarity: string; game_kind: string | null; kind: string | null;
  creator_id: string; fan_id: string | null;
  redemption: { status: string; created_at: string; fulfilled_at: string | null }[] | { status: string; created_at: string; fulfilled_at: string | null } | null;
};

/** null = no such win; "error" = the read failed. spinId is for the audit entry only, never the response. */
export async function lookupWin(shareId: string): Promise<{ win: AdminWinLookup; spinId: string | null } | null | "error"> {
  if (!isSupabaseConfigured()) {
    const win = mockAdminLookupWin(shareId);
    return win ? { win, spinId: null } : null;
  }
  try {
    const svc = createServiceClient();
    const { data, error } = await svc.from("spins")
      .select("id, share_id, created_at, prize_label, prize_rarity, game_kind, kind, creator_id, fan_id, redemption:redemptions(status, created_at, fulfilled_at)")
      .eq("share_id", shareId).abortSignal(AbortSignal.timeout(5_000)).maybeSingle();
    if (error) return "error";
    const row = data as unknown as SpinRow | null;
    if (!row) return null;
    const { data: creator } = await svc.from("profiles").select("display_name, is_active, approval_status").eq("id", row.creator_id).maybeSingle();
    const c = creator as { display_name: string | null; is_active: boolean; approval_status: string } | null;
    const red = Array.isArray(row.redemption) ? row.redemption[0] ?? null : row.redemption;
    const win: AdminWinLookup = {
      shareId: row.share_id,
      at: row.created_at,
      prize: row.prize_label,
      rarity: row.prize_rarity,
      gameKind: row.game_kind ?? "wheel",
      kind: row.kind ?? "play",
      creator: { id: row.creator_id, title: c?.display_name ?? null, status: c ? (c.is_active ? c.approval_status : "suspended") : "deleted" },
      redemption: red ? { status: red.status, createdAt: red.created_at, fulfilledAt: red.fulfilled_at ?? null } : null,
      fanDeleted: row.fan_id === null,
    };
    return { win, spinId: row.id };
  } catch {
    return "error";
  }
}
