import { resolveWheelId } from "./wheels";
import { focusDisplay } from "./focusDisplay";
import { toWheelConfig, type DbWheelRow } from "./shared";
import { fanEngagementAllowed, isOnBreak } from "@/lib/play/playGuard";
import "server-only";
import { createClient, createServiceClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { isUuid } from "./shared";
import { toFanFocusView, type CreatorFocusView, type FanFocusView, type FanOddsView, type FocusRow } from "./focusView";
import type { CampaignPack } from "./types";
import { mockCancelFanFocus, mockGetCreatorFocus, mockGrantFocusPack } from "./mock";

export type FocusError = { error: "unauthorized" | "forbidden" | "not_found" | "bad_request" | "db_error" | "unavailable" | "invalid_pack" | "invalid_target" | "focus_exists" | "sold_out" | "conflict" | "cancelled" | "rejected" | "gone" };
type Service = ReturnType<typeof createServiceClient>;
type Rpc = { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> };
async function rpc(service: Service, name: string, args: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  try { const { data, error } = await (service as unknown as Rpc).rpc(name, args); return !error && data && typeof data === "object" ? data as Record<string, unknown> : null; }
  catch { return null; }
}
/** Session getUser and explicit grant permission; JWT metadata is never an authority. */
async function creatorForFan(fanId: string): Promise<{ creatorId: string; actorId: string; service: Service; blocked: boolean; breakUntil: string | null } | FocusError> {
  if (!isUuid(fanId)) return { error: "not_found" };
  const session = await createClient();
  const { data: { user }, error } = await session.auth.getUser();
  if (error || !user) return { error: "unauthorized" };
  const { data: fan, error: readError } = await session.from("fans").select("creator_id,blocked_at,break_until").eq("id", fanId).maybeSingle();
  if (readError || !fan) return { error: "not_found" };
  const { data: permitted, error: permissionError } = await session.rpc("can_act_for", { target_creator: fan.creator_id, perm: "grant" });
  if (permissionError || permitted !== true) return { error: "forbidden" };
  return { creatorId: fan.creator_id, actorId: user.id, service: createServiceClient(), blocked: !!fan.blocked_at, breakUntil: fan.break_until };
}
export async function getFanFocus(token: string): Promise<FanFocusView | null> { return (await getFanFocusDisplay(token)).focus; }
export async function getFanFocusDisplay(token: string, service?: Service): Promise<{ focus: FanFocusView | null; odds?: FanOddsView; stock?: Record<string, import("@/lib/games/wheel/types").PublicStock> }> {
  if (!isSupabaseConfigured()) {
    const { mockFanFocusDisplay } = await import("./mock");
    return mockFanFocusDisplay(token);
  }
  const result = await rpc(service ?? createServiceClient(), "get_fan_focus_state", { p_token: token });
  // Absence is authoritative only after a successful explicit read. A stale
  // receipt must never lose a known promise because fresh metadata is unknown.
  if (result?.status !== "ok" || !Object.hasOwn(result,"focus") ||
    (result.focus !== null && (!result.focus || typeof result.focus !== "object" || Array.isArray(result.focus) || typeof (result.focus as Record<string,unknown>).prize_id !== "string"))) {
    throw new Error("focus_read_unavailable");
  }
  const context = result.context as { wheel: DbWheelRow; prizes: DbWheelRow["prizes"]; pityCounter: number; happyHourMultiplier: number | null; reserved: boolean; breakUntil?: string | null } | undefined;
  if (!context?.wheel) return { focus: toFanFocusView(result.focus as FocusRow | null) };
  return focusDisplay(result.focus as FocusRow | null, toWheelConfig({ ...context.wheel, prizes: context.prizes }), context);
}
export async function getCreatorFocus(fanId: string): Promise<CreatorFocusView | FocusError> {
  if (!isSupabaseConfigured()) return mockGetCreatorFocus(fanId);
  const auth = await creatorForFan(fanId);
  if ("error" in auth) return auth;
  const { service: sb, creatorId } = auth;
  const [focus, wheels, passes, packs, config, wishes] = await Promise.all([
    sb.from("fan_focus").select("*").eq("creator_id", creatorId).eq("fan_id", fanId).in("status", ["active", "paused"]).maybeSingle(),
    sb.from("wheels").select("id,title,archived_at,prizes(id,label,emoji,rarity,stock,weight,boostable,delivery)").eq("creator_id", creatorId).is("archived_at", null),
    sb.from("fan_passes").select("id,creator_id,campaign_id,wheel_id,token,spins_remaining").eq("creator_id", creatorId).eq("fan_id", fanId).eq("is_active", true).is("self_excluded_at", null),
    sb.from("campaign_packs").select("*").eq("creator_id", creatorId).in("pack_kind", ["focus", "chase"]).order("sort_order"),
    sb.from("focus_creator_config").select("focus_enabled,chase_enabled").eq("creator_id", creatorId).maybeSingle(),
    sb.from("wishlists").select("prize_id").eq("creator_id", creatorId).eq("fan_id", fanId),
  ]);
  if ([focus, wheels, passes, packs, config, wishes].some(x => x.error)) return { error: "db_error" };
  const targets = (wheels.data ?? []).flatMap(wheel => (wheel.prizes ?? []).filter(prize => prize.boostable).map(prize => ({
    id: prize.id, label: prize.label, wishlisted: (wishes.data ?? []).some(wish => wish.prize_id === prize.id), ...(prize.emoji ? { emoji: prize.emoji } : {}), rarity: prize.rarity, weight: prize.weight,
    wheelId: wheel.id, wheelTitle: wheel.title, available: prize.stock == null || prize.stock > 0, finite: prize.stock != null, delivery: prize.delivery,
  })));
  const mappedPacks: CampaignPack[] = (packs.data ?? []).map(pack => ({ id: pack.id, campaignId: pack.campaign_id, label: pack.label,
    spins: pack.spins, bonusSpins: pack.bonus_spins, amountCents: pack.amount_cents, sortOrder: pack.sort_order, createdAt: pack.created_at,
    packKind: pack.pack_kind as CampaignPack["packKind"], focusMultiplier: Number(pack.focus_multiplier), focusSpins: pack.focus_spins, chaseWithin: pack.chase_within }));
  const passViews = await Promise.all((passes.data ?? []).map(async pass => {
    const resolved = await resolveWheelId(sb, pass, new Date());
    return { id: pass.id, wheelId: resolved ?? pass.wheel_id, wheelTitle: (wheels.data ?? []).find(wheel => wheel.id === resolved)?.title ?? "Wheel", spinsRemaining: pass.spins_remaining };
  }));
  const focusPass = (passes.data ?? []).find(pass => pass.id === (focus.data as FocusRow | null)?.fan_pass_id);
  let displayFocus: FanFocusView | null;
  try { displayFocus = focusPass ? (await getFanFocusDisplay(focusPass.token, sb)).focus : toFanFocusView(focus.data); }
  catch { return { error: "db_error" }; }
  return { focusId: (focus.data as FocusRow | null)?.id ?? null, focus: displayFocus, targets, passes: passViews,
    focusEnabled: config.data?.focus_enabled !== false,
    canGrant: config.data?.focus_enabled !== false && fanEngagementAllowed({ blocked: auth.blocked, selfExcluded: !passes.data?.length, breakUntil: auth.breakUntil }) && !focus.data && !!passes.data?.length,
    ...(config.data?.focus_enabled === false ? { blockedReason: "focus_disabled" as const } : auth.blocked ? { blockedReason: "blocked" as const } : isOnBreak(auth.breakUntil) ? { blockedReason: "on_break" as const } : focus.data ? { blockedReason: "active_focus" as const } : !passes.data?.length ? { blockedReason: "no_active_pass" as const } : {}),
    packs: mappedPacks, chaseEnabled: config.data?.focus_enabled === true && config.data?.chase_enabled === true };
}
export async function grantFocusPack(fanId: string, input: { requestId: string; packId: string; prizeId: string; passId: string }): Promise<{ focus: FanFocusView | null; spinsRemaining: number; grantId: string; replayed: boolean } | FocusError> {
  if (!isUuid(input.requestId) || (![input.packId, input.prizeId, input.passId].every(isUuid) && isSupabaseConfigured())) return { error: "bad_request" };
  if (!isSupabaseConfigured()) return mockGrantFocusPack(fanId, input);
  const auth = await creatorForFan(fanId);
  if ("error" in auth) return auth;
  const result = await rpc(auth.service, "grant_focus_pack", { p_request: input.requestId, p_creator: auth.creatorId, p_fan: fanId, p_pass: input.passId, p_pack: input.packId, p_prize: input.prizeId, p_actor: auth.actorId });
  if (!result) return { error: "db_error" };
  if (result.status !== "granted") {
    const allowed = ["unavailable", "invalid_pack", "invalid_target", "focus_exists", "sold_out", "conflict", "cancelled", "rejected", "gone"] as const;
    return { error: allowed.includes(result.status as typeof allowed[number]) ? result.status as typeof allowed[number] : "db_error" };
  }
  return { focus: toFanFocusView(result.focus as FocusRow), spinsRemaining: Number(result.balance), grantId: String(result.grantId), replayed: result.replayed === true };
}
export async function cancelFanFocus(fanId: string, focusId: string): Promise<{ focusId: string; released: boolean; focus: FanFocusView | null } | FocusError> {
  if (!isUuid(focusId)) return { error: "bad_request" };
  if (!isSupabaseConfigured()) {
    const result = mockCancelFanFocus(fanId, focusId);
    return "error" in result ? result : { ...result, focusId };
  }
  const auth = await creatorForFan(fanId);
  if ("error" in auth) return auth;
  const result = await rpc(auth.service, "cancel_fan_focus", { p_creator: auth.creatorId, p_fan: fanId, p_focus: focusId, p_actor: auth.actorId });
  // The gateway intentionally uses the same unavailable shape for a lost
  // permission and a concurrently removed fan; do not expose that distinction.
  if (result?.status === "unavailable") return { error: "forbidden" };
  return result?.status === "released" || result?.status === "absent" ? { focusId, released: result.status === "released", focus: toFanFocusView(result.focus as FocusRow) } : { error: "db_error" };
}

export async function getFocusConfig(): Promise<{ focusEnabled: boolean; chaseEnabled: boolean; reason: "rollout_disabled" | "focus_disabled" | null } | FocusError> {
  if (!isSupabaseConfigured()) {
    const { mockFocusState } = await import("./mockFocus");
    const chaseEnabled = mockFocusState().chaseEnabled === true;
    return { focusEnabled: true, chaseEnabled, reason: chaseEnabled ? null : "rollout_disabled" };
  }
  const session = await createClient();
  const { data: { user }, error } = await session.auth.getUser();
  if (error || !user) return { error: "unauthorized" };
  const { data: permission, error: denied } = await session.rpc("can_act_for", { target_creator: user.id, perm: "grant" });
  if (denied || permission !== true) return { error: "forbidden" };
  const { data, error: configError } = await createServiceClient().from("focus_creator_config").select("focus_enabled,chase_enabled").eq("creator_id", user.id).maybeSingle();
  if (configError) return { error: "db_error" };
  const focusEnabled = data?.focus_enabled !== false;
  const chaseEnabled = focusEnabled && data?.chase_enabled === true;
  return { focusEnabled, chaseEnabled, reason: !focusEnabled ? "focus_disabled" : chaseEnabled ? null : "rollout_disabled" };
}

/** Token-authenticated polling: the same closed-link refusals as the other F5 endpoints. */
export async function getFanFocusState(token: string): Promise<{ focus: FanFocusView | null; odds?: FanOddsView; stock?: Record<string, import("@/lib/games/wheel/types").PublicStock> } | { error: "not_found" | "blocked" | "db_error" }> {
  if (!isSupabaseConfigured()) {
    const { mockFanFocusState } = await import("./mock");
    return mockFanFocusState(token);
  }
  const sb = createServiceClient();
  const { data, error } = await sb.from("fan_passes").select("is_active,self_excluded_at,fan:fans(blocked_at)").eq("token", token).maybeSingle();
  if (error) return { error: "db_error" };
  if (!data) return { error: "not_found" };
  const pass = data as unknown as { is_active: boolean; self_excluded_at: string | null; fan: { blocked_at: string | null } | null };
  if (!pass.is_active || pass.self_excluded_at || !pass.fan || pass.fan.blocked_at) return { error: "blocked" };
  try { return await getFanFocusDisplay(token,sb); } catch { return { error: "db_error" }; }
}
