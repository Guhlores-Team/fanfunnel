import { issueCreatorActorContext } from "@/lib/auth/creatorActorContext";
import { readBingoCard } from "./bingo";
import { applyFocusStock } from "./focusDisplay";
import { commitSpinAttempt, readSpinAttempt, type SpinIntent, type SpinAttemptStatus } from "./spinAttempts";
import { getFanFocusDisplay } from "./focus";
import { mockReadSpinAttempt } from "./mock";
// Data layer — fan passes and spins: the fan-facing pass view, the spin
// entry point (every credited play commits through the 0059 attempt ledger
// in ./spinAttempts: one prepare, one commit, no split writes) and minting
// passes. The pre-0059 claim/record/stock path is gone; its RPCs are revoked.
import { isSupabaseConfigured, createServiceClient, createClient } from "@/lib/supabase/server";
import { normalizeClientSeed } from "@/lib/games/wheel/fairness";
import type { Rarity, SpinResult } from "@/lib/games/wheel/types";
import { RARITY_COLORS } from "@/lib/games/wheel/types";
import { toPublicWheel } from "@/lib/games/wheel/publicView";
import type { FanPassView, WishlistItem } from "./types";
import { mockGetFanPass, mockSpin, mockCreatePass, mockSpinPushEvent } from "./mock";
import {
  REFERRAL_BONUS,
  WHEEL_SELECT,
  isUuid,
  toWheelConfig,
} from "./shared";
import type { DbWheelRow, SpinError } from "./shared";
import { getActiveHappyHour, resolveWheelId } from "./wheels";
import { runAfterResponse } from "@/lib/afterResponse";
import { readPlayState } from "./playGuard";
import { readFanGlow } from "./checkins";
import { fanNeedsAck } from "@/lib/legal";
import { firstEmbedded, toWinDelivery, type WinDelivery } from "@/lib/fan/delivery";
import { notifyCreator } from "@/lib/push/notify";
import { publicCreatorTitle } from "@/lib/publicCreator";

// ---------------------------------------------------------------------------
// Public API. Transparently uses the in-memory mock store when Supabase isn't
// configured, so local dev and previews work with zero setup.
// ---------------------------------------------------------------------------

/** A transient database fault while reading a fan link: the page must retry, not 404. */
export class FanPassUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FanPassUnavailableError";
  }
}

/**
 * The fan's pass view, or null when no active link matches. Throws
 * {@link FanPassUnavailableError} on a database fault so a transient outage
 * reaches the error boundary (retryable) instead of rendering "link not found".
 */
export async function getFanPass(token: string): Promise<FanPassView | null> {
  if (!isSupabaseConfigured()) return mockGetFanPass(token);

  const sb = createServiceClient();
  const FAN = `fan:fans(id, display_name, handle, spins_remaining, spins_granted_total, referral_code, acked_at, acked_terms_version, leaderboard_opt_in, blocked_at)`;
  const CREATOR = `creator:profiles(display_name, tip_url, leaderboard_enabled, creator_note, avatar_url)`;
  // The per-pass balance (0020) and the commit-reveal hash (0022) are part
  // of every deployed schema: a failing select is a transient fault, never a
  // missing column. Surfacing it (the error boundary offers a retry) beats
  // degrading to "link not found" or to a stale aggregate balance.
  const primary = await sb
    .from("fan_passes")
    .select(`id, creator_id, campaign_id, wheel_id, pinned_wheel_id, fan_id, is_active, spins_remaining, next_server_seed_hash, ${FAN}, ${CREATOR}`)
    .eq("token", token)
    .eq("is_active", true)
    .maybeSingle();
  if (primary.error) throw new FanPassUnavailableError("fan_passes read failed");
  const data: unknown = primary.data;

  const pass = data as unknown as {
    id: string;
    creator_id: string;
    campaign_id: string | null;
    wheel_id: string;
    pinned_wheel_id?: string | null; // per-fan game pin (migration 0065)
    fan_id: string;
    spins_remaining: number;
    next_server_seed_hash: string | null;
    fan: {
      id: string;
      display_name: string | null;
      handle: string | null;
      spins_remaining: number;
      spins_granted_total: number;
      referral_code: string | null;
      acked_at: string | null;
      acked_terms_version?: string | null;
      leaderboard_opt_in?: boolean | null;
      blocked_at?: string | null;
    } | null;
    creator: {
      display_name: string | null;
      tip_url: string | null;
      leaderboard_enabled: boolean | null;
      creator_note: string | null;
      avatar_url: string | null;
    } | null;
  } | null;

  if (!pass || !pass.fan) return null;

  // A41: everything below depends only on the pass, so the reads run
  // together instead of one after another (this is every fan page load).
  // The focus/odds read is started now and awaited at the end, exactly as
  // before (a failed read still fails the page); the catch only stops an
  // early `return null` from leaving an unhandled rejection behind.
  const focusRead = getFanFocusDisplay(token);
  focusRead.catch(() => {});

  // Commit-reveal: make sure this pass holds a pre-committed seed for the
  // fan's NEXT spin, and publish its hash on the page. Generating it here
  // (page load) rather than at spin time is the entire point: the commitment
  // observably predates the spin request.
  const commitRead: Promise<{ hash: string | null }> = pass.next_server_seed_hash
    ? Promise.resolve({ hash: pass.next_server_seed_hash })
    : Promise.resolve(sb.rpc("ensure_pass_commitment", { p_token: token })).then(({ data: committed, error }) => {
        if (error) throw new FanPassUnavailableError("ensure_pass_commitment failed");
        return { hash: (committed as { hash?: string } | null)?.hash ?? null };
      });

  // Resolve WHICH wheel this link points at right now, then load its config.
  const wheelRead = (async () => {
    const id = await resolveWheelId(sb, pass, new Date());
    if (!id) return null;
    const { data } = await sb.from("wheels").select(WHEEL_SELECT).eq("id", id).maybeSingle();
    return data ? { id, wheel: data as unknown as DbWheelRow } : null;
  })();

  const [commitment, resolved] = await Promise.all([commitRead, wheelRead]);
  if (!resolved) return null;
  const nextSpinHash = commitment.hash;
  const { id: wheelId, wheel } = resolved;
  if (wheel.game_ready === false) return null;

  // The fan's win history, wishlist, and the active happy-hour are all
  // independent reads keyed off the now-known fan/wheel — fetch concurrently
  // instead of one after another (this is on every fan page load).
  const [{ data: wins }, { data: wishRows }, happyHour, play, glow, bingo] = await Promise.all([
    // Win history is scoped to the fan ACCOUNT, so it persists across every
    // link the creator has ever minted for them.
    sb
      .from("spins")
      // #26: `reward` only says the win was instant (its kind), never the value.
      // T5: the win's redemption status and delivery time (never notes or due dates).
      .select("prize_label, prize_rarity, prize_image_url, share_id, created_at, reward:spin_rewards(kind), redemption:redemptions(status, fulfilled_at)")
      .eq("fan_id", pass.fan.id)
      .order("created_at", { ascending: false })
      .limit(50),
    sb
      .from("wishlists")
      .select("id, prize_label, prize_rarity, created_at")
      .eq("fan_id", pass.fan.id)
      .order("created_at", { ascending: false }),
    getActiveHappyHour(sb, wheelId, new Date(), pass.creator_id),
    // RM-6: the fan's own counts, reminder and break (best-effort).
    readPlayState(sb, pass.fan.id),
    readFanGlow(sb, pass.fan.id),
    wheel.game_kind === "bingo"
      ? readBingoCard(token, sb).then((card) => ({ ok: true as const, card }), () => ({ ok: false as const }))
      : Promise.resolve(null),
  ]);
  if (bingo && !bingo.ok) return null;

  const winRows = (wins ?? []) as unknown as {
    prize_label: string;
    prize_rarity: Rarity;
    prize_image_url: string | null;
    share_id: string | null;
    created_at: string;
    // One-to-one embed: PostgREST sends an object (or null); tolerate an array.
    reward?: { kind: string } | { kind: string }[] | null;
    redemption?: RedemptionEmbed | RedemptionEmbed[] | null;
  }[];

  const wishlist: WishlistItem[] = (
    (wishRows ?? []) as {
      id: string;
      prize_label: string;
      prize_rarity: Rarity;
      created_at: string;
    }[]
  ).map((w) => ({
    id: w.id,
    prizeLabel: w.prize_label,
    rarity: w.prize_rarity,
    at: w.created_at,
  }));

  const bingoCard = bingo?.ok ? bingo.card : undefined;
  const focusDisplay = await focusRead;
  return {
    ...(wheel.game_kind === "bingo"?{bingoCard}:{}),
    token,
    blocked: !!pass.fan.blocked_at,
    fanName: pass.fan.display_name ?? pass.fan.handle ?? null,
    fanHandle: pass.fan.handle ?? null,
    creatorTitle: publicCreatorTitle(pass.creator?.display_name),
    // Per-wheel: the balance the fan can spin on THIS wheel's link, the same
    // value the attempt ledger decrements, so the count matches before and
    // after a spin (never the fan-level aggregate across every link).
    spinsRemaining: pass.spins_remaining ?? 0,
    // Fan-safe projection: no creator-private fields (prize cost) on the page.
    wheel: applyFocusStock(toPublicWheel(toWheelConfig(wheel)), focusDisplay.stock),
    recentWins: winRows.map((w) => ({
      label: w.prize_label,
      rarity: w.prize_rarity,
      color: RARITY_COLORS[w.prize_rarity],
      at: w.created_at,
      shareId: w.share_id ?? undefined,
      imageUrl: w.prize_image_url ?? null,
      ...(hasEmbeddedRow(w.reward) ? { instant: true } : {}),
      ...winDelivery(w.redemption),
    })),
    wishlist,
    happyHour,
    referral: {
      code: pass.fan.referral_code ?? "",
      bonusPerReferral: REFERRAL_BONUS,
    },
    chatUnlocked:
      pass.fan.spins_remaining > 0 || pass.fan.spins_granted_total > 0,
    needsAck: fanNeedsAck(pass.fan.acked_at, pass.fan.acked_terms_version),
    tipUrl: pass.creator?.tip_url ?? null,
    creatorId: pass.creator_id,
    leaderboardEnabled: pass.creator?.leaderboard_enabled ?? false,
    // Default false: anything other than an explicit true means "not opted in".
    leaderboardOptIn: pass.fan.leaderboard_opt_in === true,
    creatorNote: pass.creator?.creator_note ?? null,
    creatorAvatarUrl: pass.creator?.avatar_url ?? null,
    nextSpinHash,
    play,
    glow,
    ...focusDisplay,
  };
}

export async function spin(token: string, rawClientSeed?: unknown, requestId = crypto.randomUUID(), publishedSeedHash?: string): Promise<SpinResult | SpinError> {
  const clientSeed = normalizeClientSeed(rawClientSeed);
  if (!isSupabaseConfigured()) {
    const result = await mockSpin(token, clientSeed, requestId, publishedSeedHash);
    if (!("error" in result) && !result.replayed) {
      for(const shareId of [result.shareId,...(result.bonusWins??[]).map(win=>win.shareId)]){
        const event = mockSpinPushEvent(token,shareId);
        if (event) runAfterResponse(() => notifyCreator("demo", { type: "spin", ...event }));
      }
    }
    return result;
  }
  const sb = createServiceClient();
  // Fail closed before opening an attempt; the transaction checks the same consent again under its locks.
  const { data: ackRow, error: ackError } = await sb.from("fan_passes")
    .select("fan_id, fan:fans(acked_at, acked_terms_version)").eq("token", token).maybeSingle();
  if (ackError) return { error: "db_error" };
  if (!ackRow) return { error: "not_found" };
  const ack = ackRow as unknown as { fan: { acked_at: string | null; acked_terms_version: string | null } | null };
  if (fanNeedsAck(ack.fan?.acked_at, ack.fan?.acked_terms_version)) return { error: "needs_ack" };
  return commitSpinAttempt(token, { requestId, clientSeed, publishedSeedHash }, sb);
}

export async function getSpinAttemptStatus(token: string, intent: SpinIntent): Promise<SpinAttemptStatus> {
  return isSupabaseConfigured() ? readSpinAttempt(token, intent) : mockReadSpinAttempt(token, intent);
}

type RedemptionEmbed = { status: string; fulfilled_at: string | null };

/** T5: the fan-facing delivery state of a win, when it has a redemption row. */
function winDelivery(embed: RedemptionEmbed | RedemptionEmbed[] | null | undefined): { delivery?: WinDelivery } {
  const row = firstEmbedded(embed);
  const delivery = row ? toWinDelivery(row.status, row.fulfilled_at) : undefined;
  return delivery ? { delivery } : {};
}

/** A one-to-one embed that holds a row (PostgREST returns an object; arrays tolerated). */
export function hasEmbeddedRow(v: unknown): boolean {
  return Array.isArray(v) ? v.length > 0 : v != null;
}

/** Retry the same durable economic intent after an ambiguous transport error.
 * The database owns all balances, grant rows and bootstrap cleanup atomically. */
async function passTransaction(name: string, args: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const service = createServiceClient() as unknown as { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { data, error } = await service.rpc(name, args);
      if (!error) return data && typeof data === "object" ? data as Record<string, unknown> : null;
      if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && error.code && !error.code.startsWith("PGRST")) return null;
    } catch { /* Same request ID, never a compensating balance write. */ }
  }
  return null;
}

/**
 * Create a link. Without `fanId`, creates a NEW fan account. With `fanId`,
 * mints a fresh link for that SAME account (history + balance preserved) and
 * adds the granted spins to the account's balance.
 */
export async function createPass(opts: {
  name: string;
  spins: number;
  fanId?: string;
  wheelId?: string;
  campaignId?: string;
  amountCents?: number;
  packId?: string;
  packUnits?: number;
  bonusSpins?: number;
  referralCode?: string;
  /** Reuse this intent UUID when retrying a request. */
  requestId?: string;
}): Promise<{ token: string; fanId: string; requestId: string } | { error: string }> {
  if (![opts.spins, opts.amountCents ?? 0, opts.bonusSpins ?? 0].every(Number.isFinite)) return { error: "invalid" };
  if (opts.requestId !== undefined && !isUuid(opts.requestId)) return { error: "invalid" };
  const packUnits = opts.packUnits ?? 1;
  if (!Number.isInteger(packUnits) || packUnits < 1 || packUnits > 1_000_000) return { error: "invalid" };
  if (!opts.packId && packUnits !== 1) return { error: "invalid_pack" };
  const requestId = opts.requestId ?? crypto.randomUUID();
  const spins = Math.max(0, Math.floor(opts.spins) || 0);
  const amountCents = Math.max(0, Math.floor(opts.amountCents ?? 0) || 0);
  const bonusSpins = Math.max(0, Math.floor(opts.bonusSpins ?? 0) || 0);
  if (!isSupabaseConfigured()) {
    try {
      const result = mockCreatePass(opts.name, spins, opts.fanId, opts.campaignId, amountCents, bonusSpins, opts.packId, opts.referralCode, opts.wheelId, requestId, packUnits);
      return { ...result, requestId };
    } catch (error) {
      const code = error instanceof Error ? error.message : "db_error";
      return { error: ["conflict", "invalid_pack", "blocked", "on_break", "not_found", "fan_not_found", "gone"].includes(code) ? code : "db_error" };
    }
  }

  const sb = await createClient();
  const { data: { user }, error: authError } = await sb.auth.getUser();
  if (authError || !user) return { error: "unauthorized" };
  let creatorId = user.id;
  if (opts.fanId) {
    const { data: fan, error } = await sb.from("fans").select("id, creator_id").eq("id", opts.fanId).maybeSingle();
    if (error) return { error: "db_error" };
    if (!fan) return { error: "fan_not_found" };
    creatorId = fan.creator_id;
  }
  const { data: allowed, error: permissionError } = await sb.rpc("can_act_for", { target_creator: creatorId, perm: "grant" });
  if (permissionError || allowed !== true) return { error: "unauthorized" };

  // Pack terms are resolved and locked by the transaction, after checking an
  // existing request. A later pack edit/deletion cannot break a lost-response
  // replay or replace the price agreed by the first committed request.
  // Effective balance added = paid spins + bonus spins.
  const balanceAdd = spins + bonusSpins;
  if (!opts.packId && (balanceAdd > 1_000_000 || amountCents > 100_000_000)) return { error: "invalid" };

  const campaignId = opts.campaignId ?? null;

  // Keep raw wheel/campaign intent unchanged for durable retries. The database
  // resolves default wheels and validates ownership only for a fresh request.
  const wheelId = opts.wheelId ?? null;

  // The wrapper binds the complete intent before creating anything. New fan,
  // zero-balance pass, grant and its credit either all commit or all roll back.
  const context = await issueCreatorActorContext(sb, creatorId, "grant");
  if (!context) return { error: "unavailable" };
  const result = await passTransaction("create_pass_grant", {
    p_request: requestId, p_creator: creatorId,
    p_fan: opts.fanId ?? null, p_wheel: wheelId, p_name: opts.name || "Fan",
    p_spins: balanceAdd, p_bonus: bonusSpins, p_amount: amountCents,
    p_campaign: campaignId, p_referral_code: !opts.fanId ? opts.referralCode ?? null : null, p_pack: opts.packId ?? null, p_pack_units: packUnits, p_actor: user.id, p_context: context,
  });
  if (!result) return { error: "db_error" };
  if (result.status !== "granted" || typeof result.token !== "string" || typeof result.fanId !== "string") {
    const reason = typeof result.error === "string" ? result.error : String(result.status);
    return { error: ["conflict", "invalid", "invalid_pack", "pack_not_found", "campaign_not_found", "no_wheel", "fan_not_found", "on_break", "blocked", "gone"].includes(reason) ? reason : "unavailable" };
  }
  // The helper checks for a paid grant itself, including server-priced packs.
  // A pending referral never undoes a committed purchase; replays can retry it.
  const referral = await passTransaction("award_fan_referral", { p_creator: creatorId, p_fan: result.fanId });
  if (!referral) console.error("createPass: referral award pending retry");
  return { token: result.token, fanId: result.fanId, requestId };
}
