import { applyFocusStock } from "./focusDisplay";
import { commitSpinAttempt, readSpinAttempt, type SpinIntent, type SpinAttemptStatus } from "./spinAttempts";
import { getFanFocusDisplay } from "./focus";
import { mockReadSpinAttempt } from "./mock";
// Data layer — fan passes and spins: the fan-facing pass view, the spin
// engine's persistence (claim / record / stock), and minting passes.
import { isSupabaseConfigured, createServiceClient, createClient } from "@/lib/supabase/server";
import {
  makeFairRng,
  makeFairRngV3,
  normalizeClientSeed,
} from "@/lib/games/wheel/fairness";
import {
  NEW_SPIN_FAIR_VERSION,
  buildPoolSnapshot,
  drawFromSnapshot,
  hashPoolSnapshot,
  type FairTrace,
} from "@/lib/games/wheel/fairnessV3";
import type { Prize, Rarity, SpinResult } from "@/lib/games/wheel/types";
import { RARITY_COLORS } from "@/lib/games/wheel/types";
import { showsStock, toPublicPrize, toPublicWheel } from "@/lib/games/wheel/publicView";
import { readLiveStock } from "./liveStock";
import type { FanPassView, WishlistItem } from "./types";
import { consumeCommittedSeed, freshSeed } from "./spinSeed";
import { mockGetFanPass, mockSpin, mockCreatePass, mockSpinPushEvent } from "./mock";
import {
  REFERRAL_BONUS,
  WHEEL_SELECT,
  isUuid,
  toWheelConfig,
} from "./shared";
import type { AnyClient, DbWheelRow, SpinError } from "./shared";
import { getActiveHappyHour, resolveWheelId } from "./wheels";
import { fireWebhooks } from "./webhooks";
import { runAfterResponse } from "@/lib/afterResponse";
import { readPlayState } from "./playGuard";
import { readFanGlow } from "./checkins";
import { fanNeedsAck } from "@/lib/legal";
import { notifyCreator } from "@/lib/push/notify";
import { finalizeInstantSpin } from "@/lib/rewards/finalize";
import type { DeliveredReward } from "@/lib/rewards/config";

// ---------------------------------------------------------------------------
// Public API. Transparently uses the in-memory mock store when Supabase isn't
// configured, so local dev and previews work with zero setup.
// ---------------------------------------------------------------------------

export async function getFanPass(token: string): Promise<FanPassView | null> {
  if (!isSupabaseConfigured()) return mockGetFanPass(token);

  const sb = createServiceClient();
  const FAN = `fan:fans(id, display_name, handle, spins_remaining, spins_granted_total, referral_code, acked_at, acked_terms_version, leaderboard_opt_in)`;
  const CREATOR = `creator:profiles(display_name, tip_url, leaderboard_enabled, creator_note, avatar_url)`;
  // Per-wheel balance lives on the pass (migration 0020). If that column isn't
  // present yet (migration not run), fall back to the legacy select so the fan
  // page still works (using the fan-level aggregate balance) instead of 500ing.
  const primary = await sb
    .from("fan_passes")
    .select(`id, creator_id, campaign_id, wheel_id, fan_id, is_active, spins_remaining, next_server_seed_hash, ${FAN}, ${CREATOR}`)
    .eq("token", token)
    .eq("is_active", true)
    .maybeSingle();
  let data: unknown = primary.data;
  // Did the select that succeeded actually include the per-wheel balance column?
  // Only the pre-0020 legacy fallback omits it. When it's present we MUST trust
  // it (even when 0) and never fall back to the fan-level aggregate, which is a
  // SUM across every link the fan holds and would show an inflated count
  // (e.g. 18 instead of this wheel's 3).
  let hasPerPass = !primary.error;
  if (primary.error) {
    // DB has 0020 (per-wheel balances) but not 0022 (commit-reveal) yet.
    const mid = await sb
      .from("fan_passes")
      .select(`id, creator_id, campaign_id, wheel_id, fan_id, is_active, spins_remaining, ${FAN}, ${CREATOR}`)
      .eq("token", token)
      .eq("is_active", true)
      .maybeSingle();
    data = mid.data;
    hasPerPass = !mid.error;
    if (mid.error) {
      const legacy = await sb
        .from("fan_passes")
        .select(`id, creator_id, campaign_id, wheel_id, fan_id, is_active, ${FAN}, ${CREATOR}`)
        .eq("token", token)
        .eq("is_active", true)
        .maybeSingle();
      data = legacy.data;
      hasPerPass = false; // pre-0020 schema: only the aggregate exists
    }
  }

  const pass = data as unknown as {
    id: string;
    creator_id: string;
    campaign_id: string | null;
    wheel_id: string;
    fan_id: string;
    spins_remaining?: number; // present post-0020; falls back to fan aggregate
    next_server_seed_hash?: string | null; // commit-reveal (migration 0022)
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

  // Commit-reveal: make sure this pass holds a pre-committed seed for the
  // fan's NEXT spin, and publish its hash on the page. Generating it here
  // (page load) rather than at spin time is the entire point: the commitment
  // observably predates the spin request.
  let nextSpinHash = pass.next_server_seed_hash ?? null;
  // Only commit when the columns exist (primary select succeeded); on a
  // pre-0022 DB we'd otherwise publish a hash the spin could never honour.
  if (!nextSpinHash && !primary.error) {
    const { data: committed, error } = await sb.rpc("ensure_pass_commitment", { p_token: token });
    if (error) return null;
    nextSpinHash = (committed as { hash?: string } | null)?.hash ?? null;
  }

  // Resolve WHICH wheel this link points at right now, then load its config.
  const wheelId = await resolveWheelId(sb, pass, new Date());
  if (!wheelId) return null;
  const { data: wheelData } = await sb
    .from("wheels")
    .select(WHEEL_SELECT)
    .eq("id", wheelId)
    .maybeSingle();
  if (!wheelData) return null;
  const wheel = wheelData as unknown as DbWheelRow;

  // The fan's win history, wishlist, and the active happy-hour are all
  // independent reads keyed off the now-known fan/wheel — fetch concurrently
  // instead of one after another (this is on every fan page load).
  const [{ data: wins }, { data: wishRows }, happyHour, play, glow] = await Promise.all([
    // Win history is scoped to the fan ACCOUNT, so it persists across every
    // link the creator has ever minted for them.
    sb
      .from("spins")
      // #26: `reward` only says the win was instant (its kind), never the value.
      .select("prize_label, prize_rarity, prize_image_url, share_id, created_at, reward:spin_rewards(kind)")
      .eq("fan_id", pass.fan.id)
      .order("created_at", { ascending: false })
      .limit(50),
    sb
      .from("wishlists")
      .select("id, prize_label, prize_rarity, created_at")
      .eq("fan_id", pass.fan.id)
      .order("created_at", { ascending: false }),
    getActiveHappyHour(sb, wheelId, new Date()),
    // RM-6: the fan's own counts, reminder and break (best-effort).
    readPlayState(sb, pass.fan.id),
    readFanGlow(sb, pass.fan.id),
  ]);

  const winRows = (wins ?? []) as unknown as {
    prize_label: string;
    prize_rarity: Rarity;
    prize_image_url: string | null;
    share_id: string | null;
    created_at: string;
    // One-to-one embed: PostgREST sends an object (or null); tolerate an array.
    reward?: { kind: string } | { kind: string }[] | null;
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

  const focusDisplay = await getFanFocusDisplay(token);
  return {
    token,
    fanName: pass.fan.display_name ?? pass.fan.handle ?? null,
    fanHandle: pass.fan.handle ?? null,
    creatorTitle: pass.creator?.display_name ?? "Creator",
    // Per-wheel: the balance the fan can spin on THIS wheel's link. When the
    // per-pass column exists it's authoritative (even 0) — this is the same
    // value claim_spin decrements and returns, so the displayed count matches
    // before and after a spin. Only a pre-0020 DB falls back to the fan-level
    // aggregate (the sum across all the fan's links).
    spinsRemaining: hasPerPass
      ? pass.spins_remaining ?? 0
      : pass.fan.spins_remaining,
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
      const event = mockSpinPushEvent(token);
      if (event) runAfterResponse(() => notifyCreator("demo", { type: "spin", ...event }));
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

/** A one-to-one embed that holds a row (PostgREST returns an object; arrays tolerated). */
export function hasEmbeddedRow(v: unknown): boolean {
  return Array.isArray(v) ? v.length > 0 : v != null;
}

/**
 * Everything after a successful claim_spin: resolve the wheel, consume the
 * committed seed, pick + record the prize. Exported for unit tests only (the
 * public entry point is `spin`).
 */
export async function completeClaimedSpin(
  // Service client only: `rollback_claimed_spin` is revoked from `authenticated`
  // (0038), so a session client here would fail silently (serverOnlyRpc.test).
  sb: ReturnType<typeof createServiceClient>,
  token: string,
  clientSeed: string,
  spinsRemaining: number,
): Promise<SpinResult | SpinError> {
  // The fan has already paid one spin. Every exit below that is not a durably
  // recorded win refunds it — early returns and thrown errors alike — and
  // restores a limited prize's unit when one was decremented on the way.
  const refund: SpinRefund = { prizeId: null };
  let result: SpinResult | SpinError;
  try {
    result = await recordClaimedSpin(sb, token, clientSeed, spinsRemaining, refund);
  } catch (e) {
    console.error("spin: failed after claim — rolling back", e instanceof Error ? e.message : e);
    result = { error: refund.recorded || refund.outcomeUnknown ? "spin_pending" : "db_error" };
  }
  if ("error" in result && !refund.recorded && !refund.outcomeUnknown) {
    await sb.rpc("rollback_claimed_spin", { p_token: token, p_prize_id: refund.prizeId });
  }
  return result;
}

/**
 * Manual stock can require a compensating refund. Instant stock/receipts are
 * atomic; a recorded or unknown commit must never be refunded blindly.
 */
interface SpinRefund {
  prizeId: string | null;
  recorded?: boolean;
  outcomeUnknown?: boolean;
}

const MAX_STOCK_CAS_ATTEMPTS = 5;

/**
 * Take ONE unit of a limited prize's stock with a compare-and-swap on the
 * value we read. A plain `update({ stock: read - 1 }).gt("stock", 0)` lets two
 * concurrent spins that both read 3 both write 2: a unit vanishes from the
 * count and the prize is awarded more times than its stock. Guarding the write
 * on `stock = read` means exactly one spin wins each unit; a loser re-reads the
 * row and retries from the fresh value, giving up (sold out) at 0.
 *
 * "taken" means the row was decremented and the caller must refund that unit
 * on failure; "unlimited" means the prize lost its stock limit meanwhile so
 * nothing was decremented; "sold_out" means no unit is left (or the retry
 * budget ran out under pathological contention — the caller then excludes
 * the prize for this spin and re-picks, never oversells); "unknown" means the
 * UPDATE errored, so it may or may not have committed — only a clean 0-row
 * match is a definite loss that is safe to retry (a retry after a committed
 * decrement would take a SECOND unit while the refund covers one).
 */
async function takeStockUnit(
  sb: AnyClient,
  prizeId: string,
  stockRead: number,
  out?: { after?: number },
): Promise<"taken" | "unlimited" | "sold_out" | "unknown"> {
  let read = stockRead;
  for (let attempt = 0; attempt < MAX_STOCK_CAS_ATTEMPTS; attempt++) {
    if (read <= 0) return "sold_out";
    const { data: updated, error } = await sb
      .from("prizes")
      .update({ stock: read - 1 })
      .eq("id", prizeId)
      .eq("stock", read)
      .select("id")
      .maybeSingle();
    if (error) return "unknown";
    if (updated) {
      if (out) out.after = read - 1;
      return "taken";
    }
    const { data: row } = await sb.from("prizes").select("stock").eq("id", prizeId).maybeSingle();
    const current = (row as { stock: number | null } | null)?.stock;
    if (current === undefined) return "sold_out"; // prize row gone
    if (current === null) return "unlimited";
    read = current;
  }
  return "sold_out";
}

async function recordClaimedSpin(
  sb: ReturnType<typeof createServiceClient>,
  token: string,
  clientSeed: string,
  spinsRemaining: number,
  refund: SpinRefund,
): Promise<SpinResult | SpinError> {
  // 2. Load link context, then resolve WHICH wheel this spin uses + its prizes.
  const ctx = await sb
    .from("fan_passes")
    .select("id, creator_id, campaign_id, wheel_id, fan_id, next_server_seed, next_server_seed_hash")
    .eq("token", token)
    .single();
  const hasCommitRevealCols = !ctx.error;
  let data: unknown = ctx.data;
  if (ctx.error) {
    // Pre-0022 DB (no commit-reveal columns yet): fall back so spins still work.
    const legacy = await sb
      .from("fan_passes")
      .select("id, creator_id, campaign_id, wheel_id, fan_id")
      .eq("token", token)
      .single();
    data = legacy.data;
  }
  // The pass was readable a moment ago (claim_spin found it); if it is gone or
  // unreadable now, fail (and refund) rather than dereference null.
  if (!data) return { error: "db_error" };

  const pass = data as unknown as {
    id: string;
    creator_id: string;
    campaign_id: string | null;
    wheel_id: string;
    fan_id: string;
    next_server_seed: string | null;
    next_server_seed_hash: string | null;
  };

  const now = new Date();
  const wheelId = await resolveWheelId(sb, pass, now);
  if (!wheelId) return { error: "no_prizes" };

  // The wheel config, the fan's pity counter, and the active happy-hour are
  // independent reads — run them as ONE parallel group instead of three
  // sequential round-trips. This is the bulk of spin latency (each query is a
  // separate hop to Supabase), so parallelizing meaningfully speeds up the spin.
  const [wheelRes, fanRow, hh] = await Promise.all([
    sb.from("wheels").select(WHEEL_SELECT).eq("id", wheelId).maybeSingle(),
    sb.from("fans").select("pity_counter").eq("id", pass.fan_id).maybeSingle(),
    getActiveHappyHour(sb, wheelId, now),
  ]);
  const wheelData = wheelRes.data;
  if (!wheelData) return { error: "no_prizes" };
  const config = toWheelConfig(wheelData as unknown as DbWheelRow);
  const pityCounter = (fanRow.data as { pity_counter: number } | null)?.pity_counter ?? 0;
  // Fairness v3: the effective pool (happy hour applied, sold-out prizes left
  // out) with every modifier in force, as a canonical snapshot. Its hash is
  // mixed into the RNG below, so the odds are part of the derivation.
  const snapshot = buildPoolSnapshot(config, {
    happyHourMultiplier: hh.active ? hh.multiplier : null,
    pityCounter,
  });

  // Provably-fair commit-reveal: consume the seed that was PRE-committed on the
  // pass (its hash was published to the fan before this spin, so the server
  // can't grind seeds after seeing the request) and, in the same guarded
  // update, commit the NEXT spin's seed. The swap is a compare-and-swap on the
  // seed we read: claim_spin only serializes the balance, so two in-flight
  // spins on a pass with balance >= 2 would otherwise both reveal one committed
  // seed. The CAS loser consumes the winner's new commitment instead — stored
  // before it was consumed, though its hash reached the fan only in the
  // winner's response (see consumeCommittedSeed for the trade-off). A legacy
  // pass without a committed seed gets a fresh one for this spin only. (On a
  // pre-0022 DB that lacks the columns nothing is committed or rotated.)
  const nonce = spinsRemaining;
  const seeds = hasCommitRevealCols
    ? await consumeCommittedSeed(
        {
          read: async () => {
            const { data, error } = await sb
              .from("fan_passes")
              .select("next_server_seed, next_server_seed_hash")
              .eq("id", pass.id)
              .maybeSingle();
            if (error) throw new Error(`spin: seed read failed: ${error.message}`);
            const row = data as { next_server_seed: string | null; next_server_seed_hash: string | null } | null;
            return { seed: row?.next_server_seed ?? null, hash: row?.next_server_seed_hash ?? null };
          },
          swap: async (expected, next) => {
            const q = sb
              .from("fan_passes")
              .update({ next_server_seed: next.seed, next_server_seed_hash: next.hash })
              .eq("id", pass.id);
            const { data, error } = await (expected.seed
              ? q.eq("next_server_seed", expected.seed)
              : q.is("next_server_seed", null)
            )
              .select("id")
              .maybeSingle();
            // An error means we can't know whether the UPDATE committed; only a
            // clean 0-row match is a definite loss that is safe to retry.
            if (error) return "unknown";
            return data ? "won" : "lost";
          },
        },
        { seed: pass.next_server_seed, hash: pass.next_server_seed_hash },
      )
    : await freshSeed();
  if (!seeds) {
    // Lost the seed swap repeatedly (pathological contention or a DB fault):
    // fail (the caller refunds) rather than spin on an unverifiable seed.
    console.error("spin: could not consume committed seed");
    return { error: "db_error" };
  }
  const { serverSeed, serverSeedHash, nextServerSeedHash, commitment } = seeds;
  // The fan's clientSeed is mixed into the RNG so the server can't dictate the
  // outcome; under v3 the pool hash is mixed in too.
  const v3 = NEW_SPIN_FAIR_VERSION === 3;
  const poolHash = await hashPoolSnapshot(snapshot);
  const rng = v3
    ? await makeFairRngV3(serverSeed, clientSeed, nonce, poolHash)
    : await makeFairRng(serverSeed, clientSeed, nonce);

  // 3. Draw a prize from the snapshot in TS (single source of truth, the same
  //    pure draw the verify page replays), honouring pity. If a limited prize
  //    sold out between our read and write, exclude it + re-draw; each
  //    exclusion is recorded in order so the replay can re-check it.
  const byId = new Map(config.prizes.map((p, i) => [p.id, { prize: p, index: i }]));
  // #26: the spin's id is fixed before the draw, so a code can be reserved for
  // exactly this spin before its row exists (trg_attach_spin_reward then copies
  // it onto the spin in the same INSERT, or refuses the INSERT).
  const spinId = crypto.randomUUID();
  const spinCampaignId: string | null = pass.campaign_id;
  const makeSpinInsert = (prize: Prize, excluded: string[]) => ({
    id: spinId, fan_pass_id: pass.id, creator_id: pass.creator_id, wheel_id: wheelId, fan_id: pass.fan_id,
    prize_id: prize.id, prize_label: prize.label, prize_rarity: prize.rarity, prize_image_url: prize.imageUrl ?? null,
    campaign_id: spinCampaignId, server_seed: serverSeed, server_seed_hash: serverSeedHash, nonce,
    ...(hasCommitRevealCols ? { client_seed: clientSeed || null, seed_commitment: commitment } : {}),
    ...(hasCommitRevealCols && v3 ? { fair_version: 3, pool_snapshot: snapshot, pool_hash: poolHash,
      fair_trace: { excluded: [...excluded], won: prize.id } } : {}),
  });
  let finalized: Extract<Awaited<ReturnType<typeof finalizeInstantSpin>>, { status: "recorded" }> | null = null;
  let chosen: {
    prize: Prize;
    index: number;
    pityAwarded: boolean;
    nextPityCounter: number;
    reward: DeliveredReward | null;
  } | null = null;
  const excluded = new Set<string>();
  const excludedOrder: string[] = [];
  // The won prize's stock right after OUR decrement (web push: low-stock crossing).
  const stockOut: { after?: number } = {};
  try {
    for (let attempt = 0; attempt < snapshot.prizes.length + 1; attempt++) {
      const draw = drawFromSnapshot(snapshot, excluded, rng);
      const live = byId.get(draw.prize.id);
      if (!live) throw new Error("spin: drawn prize missing from the wheel config");
      const pick = { ...live, pityAwarded: draw.pityAwarded, nextPityCounter: draw.nextPityCounter, reward: null as DeliveredReward | null };
      const delivery = pick.prize.delivery ?? "manual";
      if (delivery !== "manual") {
        const outcome = await finalizeInstantSpin(sb, makeSpinInsert(pick.prize, excludedOrder), delivery, pass.creator_id);
        if (outcome.status === "pending") {
          refund.outcomeUnknown = true;
          return { error: "spin_pending" };
        }
        if (outcome.status === "failed") return { error: "db_error" };
        if (outcome.status === "recorded") {
          refund.recorded = true;
          finalized = outcome;
          chosen = { ...pick, reward: outcome.reward };
          break;
        }
        excluded.add(pick.prize.id);
        excludedOrder.push(pick.prize.id);
        continue;
      }
      if (pick.prize.stock === null || pick.prize.stock === undefined) {
        chosen = pick;
        break;
      }
      const unit = await takeStockUnit(sb, pick.prize.id, pick.prize.stock, stockOut);
      if (unit === "taken") {
        // From here on a failed spin must give this unit back too.
        refund.prizeId = pick.prize.id;
        chosen = pick;
        break;
      }
      if (unit === "unlimited") {
        // Made unlimited since our read: nothing was decremented, nothing to refund.
        chosen = pick;
        break;
      }
      if (unit === "unknown") {
        // The decrement may or may not have committed. Fail the spin (the
        // caller refunds the claimed spin) WITHOUT restoring this prize's unit:
        // adding one back when the decrement never happened would oversupply
        // the prize by a unit and let it oversell, whereas leaving it when it
        // did commit leaks one unit of stock, never a prize. Never oversell.
        console.error("spin: stock decrement outcome unknown", pick.prize.id);
        return { error: "db_error" };
      }
      excluded.add(pick.prize.id);
      excludedOrder.push(pick.prize.id);
    }
  } catch {
    // pickPrizeWithPity throws when the pool has no available prize (every prize
    // is limited-stock and already sold out). Fall through to the refund below
    // rather than letting a 500 propagate after the spin was already claimed.
  }

  if (!chosen) {
    // Sold out: the caller refunds the claimed spin so a sold-out wheel doesn't
    // burn the fan's spin for nothing.
    return { error: "no_prizes" };
  }

  // Persist the fan's next pity counter. Spinning must NOT touch
  // `leaderboard_opt_in`: appearing on the creator's public, unauthenticated
  // leaderboard is the fan's own decision, made with the toggle on their spin
  // page (POST /api/leaderboard/opt-in). It used to be set to true here, which
  // put every fan who spun on a public page they never consented to.
  const { error: pityErr } = await sb
    .from("fans")
    .update({ pity_counter: chosen.nextPityCounter })
    .eq("id", pass.fan_id);
  if (pityErr) {
    console.error("spin: pity update failed", pityErr.message);
  }

  // 4. Log the spin (against the fan account) + a pending redemption.
  const spinInsert = {
    id: spinId,
    fan_pass_id: pass.id,
    creator_id: pass.creator_id,
    wheel_id: wheelId,
    fan_id: pass.fan_id,
    prize_id: chosen.prize.id,
    prize_label: chosen.prize.label,
    prize_rarity: chosen.prize.rarity,
    prize_image_url: chosen.prize.imageUrl ?? null,
    campaign_id: spinCampaignId,
    server_seed: serverSeed,
    server_seed_hash: serverSeedHash,
    nonce,
    // Only on a 0022+ DB — including an unknown column would fail the insert.
    ...(hasCommitRevealCols ? { client_seed: clientSeed || null } : {}),
  };
  // seed_commitment (migration 0041) tells /verify whether this seed's hash was
  // published before the spin; the v3 columns (migration 0047) let it replay
  // the draw. On a DB that lacks either, PostgREST rejects the unknown column:
  // retry without that group rather than refund every spin.
  const trace: FairTrace = { excluded: excludedOrder, won: chosen.prize.id };
  let commitCols: Record<string, unknown> = hasCommitRevealCols ? { seed_commitment: commitment } : {};
  let v3Cols: Record<string, unknown> =
    hasCommitRevealCols && v3
      ? { fair_version: 3, pool_snapshot: snapshot, pool_hash: poolHash, fair_trace: trace }
      : {};
  const insertSpin = () =>
    sb.from("spins").insert({ ...spinInsert, ...commitCols, ...v3Cols }).select("id, share_id").single();
  let inserted = finalized ? { data: { id: finalized.id, share_id: finalized.shareId }, error: null } : await insertSpin();
  if (inserted.error && Object.keys(v3Cols).length && /fair_version|pool_snapshot|pool_hash|fair_trace/.test(inserted.error.message)) {
    v3Cols = {};
    inserted = await insertSpin();
  }
  if (inserted.error && Object.keys(commitCols).length && /seed_commitment/.test(inserted.error.message)) {
    commitCols = {};
    inserted = await insertSpin();
  }
  const { data: spinRow, error: spinErr } = inserted;

  // CRITICAL (revenue path): if the win couldn't be durably recorded, DON'T
  // return a "you won" the creator never sees and can't fulfil. Fail cleanly;
  // the caller rolls back the claimed spin (and restores the limited prize's
  // decremented stock) so the fan isn't charged for a phantom prize.
  if (spinErr || !spinRow) {
    console.error("spin: spins insert failed", spinErr?.message);
    return { error: "db_error" };
  }

  // #26: the reward was delivered with the spin (trg_attach_spin_reward), so
  // the creator has nothing to fulfil: the row is fulfilled, tagged Auto.
  const delivered = chosen.reward;
  const { error: redemptionErr } = finalized ? { error: null } : await sb.from("redemptions").insert({
    spin_id: spinRow.id,
    creator_id: pass.creator_id,
    status: delivered ? "fulfilled" : "pending",
    ...(delivered ? { fulfilled_at: new Date().toISOString() } : {}),
  });
  if (redemptionErr) {
    // The won prize is safely recorded in `spins`, but its fulfilment-queue row
    // failed to insert — log loudly so a won prize can't silently fall out of the
    // creator's redemptions list with no trace.
    console.error("spin: redemption insert failed", {
      spinId: spinRow.id,
      error: redemptionErr.message,
    });
  }
  // Best-effort fan-out to the creator's webhooks, run after the response via
  // after() so the host can't cut it off. Never blocks/throws — a slow or
  // failing endpoint must not break the spin.
  const webhookPayload = {
    // #26: an instant prize is already delivered (never the value itself).
    event: delivered ? "prize_delivered" : "prize_pending",
    prize: chosen.prize.label,
    rarity: chosen.prize.rarity,
    at: new Date().toISOString(),
  };
  runAfterResponse(() => fireWebhooks(pass.creator_id, webhookPayload));
  // Web push to the creator's devices, after the response too (F7). The
  // creator id is the server-side pass row's, never client input.
  const pushEvent = {
    type: "spin" as const,
    spinId: spinRow.id as string,
    fanId: pass.fan_id,
    prizeId: chosen.prize.id,
    stockAfter: finalized
      ? finalized.stockAfter
      : refund.prizeId === chosen.prize.id && stockOut.after !== undefined ? stockOut.after : null,
  };
  const pushCreator = pass.creator_id;
  runAfterResponse(() => notifyCreator(pushCreator, pushEvent));

  // RM-2: the wheel's stock after this win, projected for the fan (see liveStock.ts).
  const stock = await readLiveStock(sb, wheelId, config);

  return {
    // The spin response goes to the fan's browser: fan-safe fields only.
    prize: toPublicPrize(chosen.prize, { showStock: showsStock(config) }),
    prizeIndex: chosen.index,
    spinsRemaining,
    pityAwarded: chosen.pityAwarded,
    shareId: spinRow.share_id ?? undefined,
    nextSpinHash: nextServerSeedHash,
    ...(Object.keys(v3Cols).length ? { fairVersion: 3 as const, poolHash } : {}),
    ...(stock ? { stock } : {}),
    // #26: this winner's own response only (the route sends it no-store).
    ...(delivered ? { reward: delivered } : {}),
  };
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
  const result = await passTransaction("create_pass_grant", {
    p_request: requestId, p_creator: creatorId,
    p_fan: opts.fanId ?? null, p_wheel: wheelId, p_name: opts.name || "Fan",
    p_spins: balanceAdd, p_bonus: bonusSpins, p_amount: amountCents,
    p_campaign: campaignId, p_referral_code: !opts.fanId ? opts.referralCode ?? null : null, p_pack: opts.packId ?? null, p_pack_units: packUnits, p_actor: user.id,
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
