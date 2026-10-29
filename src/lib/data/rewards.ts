import { decodeRewardHistoryCursor, encodeRewardHistoryCursor, rewardHistoryTimestamp } from "@/lib/rewards/history";
import type { Rarity } from "@/lib/games/wheel/types";
// Data layer — #26 instant-delivery prizes (migration 0057).
//
// Creator side: a prize's Delivery (manual / link / text / code list). The
// signed-in creator's session reads the prize through RLS and the route checks
// can_act_for(creator, 'edit_wheel') explicitly; the writes then run on the
// service client through the server-only functions, which re-check that the
// prize is on that creator's wheel. Values are encrypted here before they are
// stored; codes are never read back in full.
//
// Fan side: the winner reopens their own reward with their link token (F5).
// The token's fan must own the spin; anything else looks like "no such win".
//
// Spin side: helpers recordClaimedSpin (./spins.ts) uses to take a code or load
// a link/text BEFORE the spin row exists, so a prize that can't be delivered
// is never awarded.
import { isSupabaseConfigured, createClient, createServiceClient } from "@/lib/supabase/server";
import { openReward, rewardCryptoReady, rewardCodeFingerprint, rewardCodeFingerprintReady, sealReward } from "@/lib/rewards/crypto";
import {
  CODE_PREVIEW_COUNT,
  REWARD_HISTORY_PAGE_SIZE,
  type InstantRewardHistory,
  MAX_CODES_PER_PASTE,
  codeHint,
  maskCode,
  rewardReviewAllowed,
  type DeliveredReward,
  type PrizeDelivery,
  type PrizeDeliveryView,
  type RewardKind,
} from "@/lib/rewards/config";
import { isUuid } from "./shared";
import { mockAddPrizeCodes, mockGetFanRewardHistory, mockGetFanReward, mockGetPrizeDelivery, mockSetPrizeDelivery } from "./mock";

export type RewardError = {
  error:
    | "unauthorized"
    | "forbidden"
    | "not_found"
    | "bad_request"
    | "reward_key_missing"
    | "bingo_active_card"
    | "too_many_codes"
    | "db_error";
};

type SessionClient = Awaited<ReturnType<typeof createClient>>;

/**
 * Resolve a prize the signed-in caller may edit. The prize is read on the
 * caller's own session (RLS: only prizes they can view), then authorization is
 * an explicit can_act_for(creator, 'edit_wheel') (or is_admin()) on that same
 * session, never anything the client sent.
 */
async function editablePrize(
  prizeId: string,
): Promise<{ sb: SessionClient; creatorId: string; delivery: PrizeDelivery } | RewardError> {
  if (!isUuid(prizeId)) return { error: "not_found" };
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };
  const { data } = await sb
    .from("prizes")
    .select("id, delivery, wheel:wheels(creator_id)")
    .eq("id", prizeId)
    .maybeSingle();
  const row = data as unknown as { delivery: string; wheel: { creator_id: string } | null } | null;
  const creatorId = row?.wheel?.creator_id;
  if (!row || !creatorId) return { error: "not_found" };
  const [{ data: canEdit }, { data: admin }] = await Promise.all([
    sb.rpc("can_act_for", { target_creator: creatorId, perm: "edit_wheel" }),
    sb.rpc("is_admin"),
  ]);
  if (canEdit !== true && admin !== true) return { error: "forbidden" };
  return { sb, creatorId, delivery: row.delivery as PrizeDelivery };
}

async function deliveryView(svc: ReturnType<typeof createServiceClient>, prizeId: string, creatorId: string): Promise<PrizeDeliveryView | RewardError> {
  const [{ data: prize }, { data: reward }, { data: free }, { count: used }] = await Promise.all([
    svc.from("prizes").select("delivery, stock").eq("id", prizeId).maybeSingle(),
    svc.from("prize_rewards").select("kind, cipher, iv, key_version").eq("prize_id", prizeId).maybeSingle(),
    svc
      .from("prize_reward_codes")
      .select("hint")
      .eq("prize_id", prizeId)
      .is("spin_id", null)
      .is("reserved_focus_id", null)
      .order("created_at", { ascending: true })
      .limit(CODE_PREVIEW_COUNT),
    svc
      .from("prize_reward_codes")
      .select("id", { count: "exact", head: true })
      .eq("prize_id", prizeId)
      .not("spin_id", "is", null),
  ]);
  if (!prize) return { error: "not_found" };
  const p = prize as { delivery: PrizeDelivery; stock: number | null };
  let value: string | null = null;
  if (reward && rewardCryptoReady()) {
    const r = reward as { cipher: string; iv: string; key_version: number };
    try {
      // The creator wrote this link/text; it is shown back to them only.
      value = openReward({ cipher: r.cipher, iv: r.iv, keyVersion: r.key_version }, creatorId);
    } catch {
      value = null;
    }
  }
  return {
    prizeId,
    delivery: p.delivery,
    ready: rewardCryptoReady(),
    value,
    codesLeft: p.delivery === "codes" ? p.stock ?? 0 : 0,
    codesUsed: used ?? 0,
    preview: ((free ?? []) as { hint: string | null }[]).map((c) => maskCode(c.hint)),
  };
}

/** The creator's view of one prize's delivery (codes masked). */
export async function getPrizeDelivery(prizeId: string): Promise<PrizeDeliveryView | RewardError> {
  if (!isSupabaseConfigured()) return mockGetPrizeDelivery(prizeId);
  const auth = await editablePrize(prizeId);
  if ("error" in auth) return auth;
  return deliveryView(createServiceClient(), prizeId, auth.creatorId);
}

/** Set a prize to manual, an instant link or an instant text. */
export async function setPrizeDelivery(
  prizeId: string,
  input: { kind: "manual" } | { kind: "link" | "text"; value: string },
): Promise<PrizeDeliveryView | RewardError> {
  if (!isSupabaseConfigured()) {
    return mockSetPrizeDelivery(prizeId, input.kind, input.kind === "manual" ? null : input.value);
  }
  const auth = await editablePrize(prizeId);
  if ("error" in auth) return auth;
  // Fail closed: without the key nothing instant can be stored (or delivered).
  if (input.kind !== "manual" && !rewardCryptoReady()) return { error: "reward_key_missing" };
  const svc = createServiceClient();
  const sealed = input.kind === "manual" ? null : sealReward(input.value, auth.creatorId);
  const { error } = await svc.rpc("set_prize_delivery", {
    p_prize: prizeId,
    p_creator: auth.creatorId,
    p_kind: input.kind,
    ...(sealed ? { p_cipher: sealed.cipher, p_iv: sealed.iv, p_key_version: sealed.keyVersion } : {}),
  });
  if (error) {
    console.error("rewards: set_prize_delivery failed", error.code);
    return { error: error.message === "bingo_active_card" ? "bingo_active_card" : error.code === "P0002" ? "not_found" : "db_error" };
  }
  return deliveryView(svc, prizeId, auth.creatorId);
}

/** Append pasted codes (already parsed and de-duplicated) to a prize. */
export async function addPrizeCodes(prizeId: string, codes: string[]): Promise<(PrizeDeliveryView & { added: number; duplicates: number }) | RewardError> {
  if (codes.length === 0 || codes.length > MAX_CODES_PER_PASTE) return { error: "bad_request" };
  if (!isSupabaseConfigured()) return mockAddPrizeCodes(prizeId, codes);
  const auth = await editablePrize(prizeId);
  if ("error" in auth) return auth;
  if (!rewardCryptoReady() || !rewardCodeFingerprintReady()) return { error: "reward_key_missing" };
  const rows = codes.map((code) => {
    const s = sealReward(code, auth.creatorId);
    return { cipher: s.cipher, iv: s.iv, key_version: s.keyVersion, hint: codeHint(code), fingerprint: rewardCodeFingerprint(code, auth.creatorId, prizeId) };
  });
  const svc = createServiceClient();
  const { data: added, error } = await svc.rpc("add_reward_codes", { p_prize: prizeId, p_creator: auth.creatorId, p_codes: rows });
  if (error) {
    console.error("rewards: add_reward_codes failed", error.code);
    if (error.message === "bingo_active_card") return { error: "bingo_active_card" };
    if (error.code === "P0002") return { error: "not_found" };
    if (/too many codes/.test(error.message ?? "")) return { error: "too_many_codes" };
    return { error: "db_error" };
  }
  const view = await deliveryView(svc, prizeId, auth.creatorId);
  if ("error" in view) return view;
  return { ...view, added: typeof added === "number" ? added : 0, duplicates: codes.length - (typeof added === "number" ? added : 0) };
}

// ---------------------------------------------------------------------------
// Fan: reopen a reward from the fan's own link.
// ---------------------------------------------------------------------------

export type FanRewardError = { error: "not_found" | "blocked" | "not_allowed" | "unavailable" | "db_error" };

/** Share ids are minted by the server; anything else is refused before a read. */
export function isShareIdShape(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 64 && /^[A-Za-z0-9_-]+$/.test(v);
}

export async function getFanReward(
  token: string,
  shareId: string,
): Promise<{ reward: DeliveredReward; views: number } | FanRewardError> {
  if (!isSupabaseConfigured()) return mockGetFanReward(token, shareId);
  const sb = createServiceClient();
  // F5 refusal rule: unknown link 404, paused or blocked 403, inactive 404.
  const { data: passRow, error: passErr } = await sb
    .from("fan_passes")
    .select("fan_id, is_active, self_excluded_at, fan:fans(blocked_at)")
    .eq("token", token)
    .maybeSingle();
  if (passErr) return { error: "db_error" };
  const pass = passRow as unknown as {
    fan_id: string;
    is_active: boolean;
    self_excluded_at: string | null;
    fan: { blocked_at: string | null } | null;
  } | null;
  if (!pass) return { error: "not_found" };
  if (pass.self_excluded_at || pass.fan?.blocked_at) return { error: "blocked" };
  if (!pass.is_active) return { error: "not_found" };

  const { data: spinRow } = await sb.from("spins").select("id, fan_id, creator_id").eq("share_id", shareId).maybeSingle();
  const spin = spinRow as { id: string; fan_id: string | null; creator_id: string } | null;
  // Another fan's win looks exactly like no win: no oracle for share ids.
  if (!spin || spin.fan_id !== pass.fan_id) return { error: "not_found" };
  const { data: rw } = await sb
    .from("spin_rewards")
    .select("kind, cipher, iv, key_version, created_at")
    .eq("spin_id", spin.id)
    .maybeSingle();
  const row = rw as { kind: RewardKind; cipher: string; iv: string; key_version: number; created_at: string } | null;
  if (!row) return { error: "not_found" };
  if (!rewardReviewAllowed(row.created_at)) return { error: "not_allowed" };
  let value: string;
  try {
    value = openReward({ cipher: row.cipher, iv: row.iv, keyVersion: row.key_version }, spin.creator_id);
  } catch (e) {
    console.error("rewards: a delivered reward could not be decrypted", e instanceof Error ? e.message : "error");
    return { error: "unavailable" };
  }
  const { data: views, error: viewError } = await sb.rpc("record_fan_reward_view", { p_spin: spin.id, p_token: token });
  if (viewError || typeof views !== "number" || views < 1) return { error: "db_error" };
  return { reward: { kind: row.kind, value }, views };
}

// ---------------------------------------------------------------------------
// Spin path (service client only; called by recordClaimedSpin).
// ---------------------------------------------------------------------------

/** A link/text prize's reward, decrypted, or null when it can't be delivered. */
export async function loadPrizeReward(
  sb: ReturnType<typeof createServiceClient>,
  prizeId: string,
  creatorId: string,
): Promise<DeliveredReward | null> {
  const { data } = await sb.from("prize_rewards").select("kind, cipher, iv, key_version").eq("prize_id", prizeId).maybeSingle();
  const r = data as { kind: "link" | "text"; cipher: string; iv: string; key_version: number } | null;
  if (!r) return null;
  try {
    return { kind: r.kind, value: openReward({ cipher: r.cipher, iv: r.iv, keyVersion: r.key_version }, creatorId) };
  } catch (e) {
    console.error("rewards: prize reward could not be decrypted", e instanceof Error ? e.message : "error");
    return null;
  }
}

/**
 * Take one unused code for the spin about to be recorded as `spinId`.
 *   "taken"   the code is bound to spinId (release it if the spin fails);
 *   "none"    no code left: treat the prize as sold out;
 *   "unknown" the call errored: it may or may not have committed, so the
 *             spin fails (and the reservation, if any, is released).
 */
export async function reserveRewardCode(
  sb: ReturnType<typeof createServiceClient>,
  prizeId: string,
  spinId: string,
  creatorId: string,
): Promise<{ status: "taken"; reward: DeliveredReward | null } | { status: "none" | "unknown" }> {
  const { data, error } = await sb.rpc("reserve_reward_code", { p_prize: prizeId, p_spin: spinId });
  if (error) return { status: "unknown" };
  const row = (data as { code_cipher: string; code_iv: string; code_key_version: number }[] | null)?.[0];
  if (!row) return { status: "none" };
  try {
    const value = openReward({ cipher: row.code_cipher, iv: row.code_iv, keyVersion: row.code_key_version }, creatorId);
    return { status: "taken", reward: { kind: "code", value } };
  } catch (e) {
    console.error("rewards: reward code could not be decrypted", e instanceof Error ? e.message : "error");
    return { status: "taken", reward: null };
  }
}

/** Give back the code reserved for a spin that was never recorded. */
export async function releaseRewardCode(sb: ReturnType<typeof createServiceClient>, spinId: string): Promise<void> {
  const { error } = await sb.rpc("release_reward_code", { p_spin: spinId });
  if (error) console.error("rewards: release_reward_code failed", error.code);
}

/** All earned instant-win references. No reward values, keys or internal ids. */
export async function getFanRewardHistory(token: string, cursor?: string): Promise<InstantRewardHistory | FanRewardError | { error: "bad_request" }> {
  if (!isSupabaseConfigured()) return mockGetFanRewardHistory(token, cursor);
  const anchor = cursor === undefined ? null : decodeRewardHistoryCursor(cursor);
  if (cursor !== undefined && !anchor) return { error: "bad_request" };
  const sb = createServiceClient();
  const { data, error } = await sb.from("fan_passes")
    .select("fan_id, creator_id, is_active, self_excluded_at, fan:fans(blocked_at), creator:profiles!fan_passes_creator_id_fkey(is_active)")
    .eq("token", token).maybeSingle();
  if (error) return { error: "db_error" };
  const pass = data as unknown as { fan_id: string; creator_id: string; is_active: boolean; self_excluded_at: string | null; fan: { blocked_at: string | null } | null; creator: { is_active: boolean } | null } | null;
  if (!pass || !pass.fan || !pass.is_active || !pass.creator?.is_active) return { error: "not_found" };
  if (pass.self_excluded_at || pass.fan.blocked_at) return { error: "blocked" };
  const scoped = () => sb.from("spins")
    .select("share_id, prize_label, prize_rarity, created_at, reward:spin_rewards!inner(kind)")
    .eq("fan_id", pass.fan_id).eq("creator_id", pass.creator_id).not("share_id", "is", null);
  if (anchor) {
    const { data: own, error: readError } = await scoped().eq("share_id", anchor.shareId).maybeSingle();
    if (readError) return { error: "db_error" };
    if (!own || rewardHistoryTimestamp(own.created_at) !== anchor.at) return { error: "bad_request" };
  }
  let query = scoped().order("created_at", { ascending: false }).order("share_id", { ascending: false }).limit(REWARD_HISTORY_PAGE_SIZE + 1);
  if (anchor) query = query.or(`created_at.lt.${anchor.at},and(created_at.eq.${anchor.at},share_id.lt.${anchor.shareId})`);
  const { data: rows, error: readError } = await query;
  if (readError) return { error: "db_error" };
  const all = (rows ?? []) as unknown as { share_id: string; prize_label: string; prize_rarity: Rarity; created_at: string }[];
  const wins = all.slice(0, REWARD_HISTORY_PAGE_SIZE).map((r) => ({ shareId: r.share_id, label: r.prize_label, rarity: r.prize_rarity, at: r.created_at }));
  const last = wins.at(-1);
  return { wins, nextCursor: all.length > REWARD_HISTORY_PAGE_SIZE && last ? encodeRewardHistoryCursor(last) : null };
}
