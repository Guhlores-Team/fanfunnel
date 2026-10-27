// Data layer — fan passes and spins: the fan-facing pass view, the spin
// engine's persistence (claim / record / stock), and minting passes.
import { isSupabaseConfigured, createServiceClient, createClient } from "@/lib/supabase/server";
import { pickPrizeWithPity, applyRareBoost } from "@/lib/games/wheel/engine";
import {
  randomSeedHex,
  sha256Hex,
  makeFairRng,
  normalizeClientSeed,
} from "@/lib/games/wheel/fairness";
import type { Prize, Rarity, SpinResult, WheelConfig } from "@/lib/games/wheel/types";
import { RARITY_COLORS } from "@/lib/games/wheel/types";
import { toPublicPrize, toPublicWheel } from "@/lib/games/wheel/publicView";
import type { FanPassView, WishlistItem } from "./types";
import { consumeCommittedSeed, freshSeed } from "./spinSeed";
import { mockGetFanPass, mockSpin, mockCreatePass } from "./mock";
import {
  REFERRAL_BONUS,
  REFERRAL_CAP,
  WHEEL_SELECT,
  creatorOwnsCampaign,
  randomToken,
  toWheelConfig,
} from "./shared";
import type { AnyClient, DbWheelRow, SpinError } from "./shared";
import { getActiveHappyHour, resolveWheelId } from "./wheels";
import { fireWebhooks } from "./webhooks";

// ---------------------------------------------------------------------------
// Public API. Transparently uses the in-memory mock store when Supabase isn't
// configured, so local dev and previews work with zero setup.
// ---------------------------------------------------------------------------

export async function getFanPass(token: string): Promise<FanPassView | null> {
  if (!isSupabaseConfigured()) return mockGetFanPass(token);

  const sb = createServiceClient();
  const FAN = `fan:fans(id, display_name, handle, spins_remaining, spins_granted_total, referral_code, acked_at, leaderboard_opt_in)`;
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
    const seed = randomSeedHex();
    nextSpinHash = await sha256Hex(seed);
    await sb
      .from("fan_passes")
      .update({ next_server_seed: seed, next_server_seed_hash: nextSpinHash })
      .eq("id", pass.id)
      .is("next_server_seed", null); // never clobber a concurrent commit
    // Re-read: if a concurrent request committed first, show THAT hash so the
    // published commitment always matches the seed the next spin will use.
    const { data: fresh } = await sb
      .from("fan_passes")
      .select("next_server_seed_hash")
      .eq("id", pass.id)
      .maybeSingle();
    nextSpinHash =
      (fresh as { next_server_seed_hash: string | null } | null)
        ?.next_server_seed_hash ?? nextSpinHash;
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
  const [{ data: wins }, { data: wishRows }, happyHour] = await Promise.all([
    // Win history is scoped to the fan ACCOUNT, so it persists across every
    // link the creator has ever minted for them.
    sb
      .from("spins")
      .select("prize_label, prize_rarity, prize_image_url, share_id, created_at")
      .eq("fan_id", pass.fan.id)
      .order("created_at", { ascending: false })
      .limit(50),
    sb
      .from("wishlists")
      .select("id, prize_label, prize_rarity, created_at")
      .eq("fan_id", pass.fan.id)
      .order("created_at", { ascending: false }),
    getActiveHappyHour(sb, wheelId, new Date()),
  ]);

  const winRows = (wins ?? []) as {
    prize_label: string;
    prize_rarity: Rarity;
    prize_image_url: string | null;
    share_id: string | null;
    created_at: string;
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
    wheel: toPublicWheel(toWheelConfig(wheel)),
    recentWins: winRows.map((w) => ({
      label: w.prize_label,
      rarity: w.prize_rarity,
      color: RARITY_COLORS[w.prize_rarity],
      at: w.created_at,
      shareId: w.share_id ?? undefined,
      imageUrl: w.prize_image_url ?? null,
    })),
    wishlist,
    happyHour,
    referral: {
      code: pass.fan.referral_code ?? "",
      bonusPerReferral: REFERRAL_BONUS,
    },
    chatUnlocked:
      pass.fan.spins_remaining > 0 || pass.fan.spins_granted_total > 0,
    needsAck: pass.fan.acked_at == null,
    tipUrl: pass.creator?.tip_url ?? null,
    creatorId: pass.creator_id,
    leaderboardEnabled: pass.creator?.leaderboard_enabled ?? false,
    // Default false: anything other than an explicit true means "not opted in".
    leaderboardOptIn: pass.fan.leaderboard_opt_in === true,
    creatorNote: pass.creator?.creator_note ?? null,
    creatorAvatarUrl: pass.creator?.avatar_url ?? null,
    nextSpinHash,
  };
}

export async function spin(
  token: string,
  rawClientSeed?: unknown
): Promise<SpinResult | SpinError> {
  // The fan's browser contributes this seed; sanitize + bound it server-side.
  const clientSeed = normalizeClientSeed(rawClientSeed);
  if (!isSupabaseConfigured()) {
    return mockSpin(token, clientSeed);
  }

  const sb = createServiceClient();

  // 0. Enforce the age-gate / ToS server-side BEFORE claiming a spin. The client
  //    modal is a UX affordance, not a security boundary — a fan hitting this
  //    endpoint directly must still have acknowledged first.
  const { data: ackRow } = await sb
    .from("fan_passes")
    .select("fan:fans(acked_at)")
    .eq("token", token)
    .maybeSingle();
  const ackedAt = (ackRow as unknown as { fan: { acked_at: string | null } | null } | null)
    ?.fan?.acked_at;
  if (ackRow && !ackedAt) return { error: "needs_ack" };

  // 1. Atomically claim one spin from the fan account (can't be forged).
  const { data: remaining, error: claimErr } = await sb.rpc("claim_spin", {
    p_token: token,
  });
  // -1 is the rate-limit sentinel from claim_spin (too many spins too fast).
  if (remaining === -1) return { error: "rate_limited" };
  if (claimErr || remaining === null || remaining === undefined) {
    // Distinguish blocked/self-excluded/inactive from out-of-spins.
    const { data: existsRow } = await sb
      .from("fan_passes")
      .select("id, is_active, self_excluded_at, fan:fans(blocked_at)")
      .eq("token", token)
      .maybeSingle();
    const row = existsRow as unknown as {
      id: string;
      is_active: boolean;
      self_excluded_at: string | null;
      fan: { blocked_at: string | null } | null;
    } | null;
    if (!row) return { error: "not_found" };
    if (row.fan?.blocked_at || row.self_excluded_at || !row.is_active)
      return { error: "blocked" };
    return { error: "no_spins" };
  }
  const spinsRemaining = remaining as number;
  return completeClaimedSpin(sb, token, clientSeed, spinsRemaining);
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
  const refund: { prizeId: string | null } = { prizeId: null };
  let result: SpinResult | SpinError;
  try {
    result = await recordClaimedSpin(sb, token, clientSeed, spinsRemaining, refund);
  } catch (e) {
    console.error("spin: failed after claim — rolling back", e instanceof Error ? e.message : e);
    result = { error: "db_error" };
  }
  if ("error" in result) {
    await sb.rpc("rollback_claimed_spin", { p_token: token, p_prize_id: refund.prizeId });
  }
  return result;
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
    if (updated) return "taken";
    const { data: row } = await sb.from("prizes").select("stock").eq("id", prizeId).maybeSingle();
    const current = (row as { stock: number | null } | null)?.stock;
    if (current === undefined) return "sold_out"; // prize row gone
    if (current === null) return "unlimited";
    read = current;
  }
  return "sold_out";
}

async function recordClaimedSpin(
  sb: AnyClient,
  token: string,
  clientSeed: string,
  spinsRemaining: number,
  refund: { prizeId: string | null },
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
  const pool0 = hh.active ? applyRareBoost(config, hh.multiplier) : config;

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
  // The fan's clientSeed is mixed into the RNG so the server can't dictate the outcome.
  const rng = await makeFairRng(serverSeed, clientSeed, nonce);

  // 3. Pick a prize in TS (single source of truth), honouring pity. If a
  //    limited prize sold out between our read and write, exclude it + re-pick.
  let chosen: { prize: Prize; index: number; pityAwarded: boolean; nextPityCounter: number } | null = null;
  const excluded = new Set<string>();
  try {
    for (let attempt = 0; attempt < pool0.prizes.length + 1; attempt++) {
      const pool: WheelConfig = {
        ...pool0,
        prizes: pool0.prizes.map((p) =>
          excluded.has(p.id) ? { ...p, stock: 0 } : p
        ),
      };
      const pick = pickPrizeWithPity(pool, { pityCounter }, rng);
      if (pick.prize.stock === null || pick.prize.stock === undefined) {
        chosen = pick;
        break;
      }
      const unit = await takeStockUnit(sb, pick.prize.id, pick.prize.stock);
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

  // 3b. Per-wheel attribution: the spin belongs to THIS pass's campaign (the
  //     link the fan is spinning), so spins land on the right campaign directly.
  const spinCampaignId: string | null = pass.campaign_id;

  // 4. Log the spin (against the fan account) + a pending redemption.
  const spinInsert = {
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
  // published before the spin. On a 0022+ DB that lacks 0041 PostgREST rejects
  // the unknown column: retry without it rather than refund every spin.
  let inserted = await sb
    .from("spins")
    .insert({ ...spinInsert, ...(hasCommitRevealCols ? { seed_commitment: commitment } : {}) })
    .select("id, share_id")
    .single();
  if (inserted.error && hasCommitRevealCols && /seed_commitment/.test(inserted.error.message)) {
    inserted = await sb.from("spins").insert(spinInsert).select("id, share_id").single();
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

  const { error: redemptionErr } = await sb.from("redemptions").insert({
    spin_id: spinRow.id,
    creator_id: pass.creator_id,
    status: "pending",
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
  // Best-effort fan-out to the creator's webhooks. Never blocks/throws — a slow
  // or failing endpoint must not break the spin.
  void fireWebhooks(pass.creator_id, {
    event: "prize_pending",
    prize: chosen.prize.label,
    rarity: chosen.prize.rarity,
    at: new Date().toISOString(),
  }).catch(() => {});

  return {
    // The spin response goes to the fan's browser: fan-safe fields only.
    prize: toPublicPrize(chosen.prize),
    prizeIndex: chosen.index,
    spinsRemaining,
    pityAwarded: chosen.pityAwarded,
    shareId: spinRow.share_id ?? undefined,
    nextSpinHash: nextServerSeedHash,
  };
}

/**
 * Credit `n` spins to a fan's OLDEST active pass (their original link, the same
 * convention as the `credit_pass_spins` RPC and the mock). Runs on the creator's
 * RLS-scoped session: `credit_pass_spins` is service-role only since 0027, so
 * calling it from this client was denied and the bonus silently never landed.
 * The update is a compare-and-swap on the balance just read, so a concurrent
 * spin's decrement is retried rather than overwritten. The fan aggregate is not
 * written here: the 0035 trg_sync_fan_spin_aggregate trigger recomputes it in
 * the same statement, and a separate read-sum-write would race concurrent spins.
 * Returns whether it credited.
 */
async function creditOldestActivePass(
  sb: Awaited<ReturnType<typeof createClient>>,
  creatorId: string,
  fanId: string,
  n: number
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: oldest } = await sb
      .from("fan_passes")
      .select("id, spins_remaining, spins_granted_total")
      .eq("fan_id", fanId)
      .eq("creator_id", creatorId)
      .eq("is_active", true)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    const o = oldest as
      | { id: string; spins_remaining: number; spins_granted_total: number }
      | null;
    if (!o) return false; // no active pass: nothing spendable to add to

    const { data: updated, error } = await sb
      .from("fan_passes")
      .update({
        spins_remaining: o.spins_remaining + n,
        spins_granted_total: o.spins_granted_total + n,
      })
      .eq("id", o.id)
      .eq("spins_remaining", o.spins_remaining)
      .eq("spins_granted_total", o.spins_granted_total)
      .select("id")
      .maybeSingle();
    // Transient error or the balance moved under us: re-read and retry.
    if (error || !updated) continue;
    return true;
  }
  return false;
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
  bonusSpins?: number;
  referralCode?: string;
}): Promise<{ token: string; fanId: string } | { error: string }> {
  let spins = Math.max(0, Math.floor(opts.spins) || 0);
  let amountCents = Math.max(0, Math.floor(opts.amountCents ?? 0) || 0);
  let bonusSpins = Math.max(0, Math.floor(opts.bonusSpins ?? 0) || 0);
  if (!isSupabaseConfigured()) {
    return mockCreatePass(
      opts.name,
      spins,
      opts.fanId,
      opts.campaignId,
      amountCents,
      bonusSpins,
      opts.packId,
      opts.referralCode,
      opts.wheelId
    );
  }

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  // A pack is authoritative: its spins/price/bonus override any client values.
  if (opts.packId) {
    const { data: pack } = await sb
      .from("campaign_packs")
      .select("spins, amount_cents, bonus_spins")
      .eq("id", opts.packId)
      .eq("creator_id", user.id)
      .maybeSingle();
    const p = pack as
      | { spins: number; amount_cents: number; bonus_spins: number }
      | null;
    if (!p) return { error: "pack_not_found" };
    spins = Math.max(0, p.spins);
    amountCents = Math.max(0, p.amount_cents);
    bonusSpins = Math.max(0, p.bonus_spins);
  }

  // Effective balance added = paid spins + bonus spins.
  const balanceAdd = spins + bonusSpins;

  const campaignId = opts.campaignId ?? null;

  // A client-supplied campaign id must belong to THIS creator before any write
  // references it; reject an unowned/unknown id up front so we never persist a
  // cross-tenant reference (or hit an FK failure after earlier writes land).
  if (!(await creatorOwnsCampaign(sb, user.id, campaignId)))
    return { error: "campaign_not_found" };

  // Resolve which wheel these spins are for (spins are per-wheel):
  //   explicit wheelId > the campaign's pinned wheel > the active wheel > oldest.
  let wheelId = opts.wheelId;
  // A client-supplied wheelId must belong to THIS creator. The fallback paths
  // below are already creator-scoped; this guards the explicit path so a foreign
  // wheel id is rejected up front rather than minting a pass that references
  // another tenant's wheel (defense in depth on top of RLS).
  if (wheelId) {
    const { data: ownWheel } = await sb
      .from("wheels")
      .select("id")
      .eq("id", wheelId)
      .eq("creator_id", user.id)
      .maybeSingle();
    if (!ownWheel) return { error: "no_wheel" };
  }
  if (!wheelId && campaignId) {
    const { data: camp } = await sb
      .from("campaigns")
      .select("pinned_wheel_id")
      .eq("id", campaignId)
      .eq("creator_id", user.id)
      .maybeSingle();
    wheelId = (camp as { pinned_wheel_id: string | null } | null)?.pinned_wheel_id ?? undefined;
  }
  if (!wheelId) {
    const { data: active } = await sb
      .from("wheels")
      .select("id")
      .eq("creator_id", user.id)
      .eq("is_active", true)
      .is("archived_at", null)
      .maybeSingle();
    wheelId = (active as { id: string } | null)?.id;
  }
  if (!wheelId) {
    const { data: w } = await sb
      .from("wheels")
      .select("id")
      .eq("creator_id", user.id)
      .is("archived_at", null)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    wheelId = w?.id;
  }
  if (!wheelId) return { error: "no_wheel" };

  // createPass is not a single DB transaction: the fan/pass/top-up, grant, and
  // referral writes land as separate statements. If a later write fails we must
  // undo the ones that already succeeded — otherwise a usable link or a changed
  // balance would persist even though the API reports failure. Each successful
  // write pushes an inverse here; `fail()` runs them newest-first (so child rows
  // are removed before their parents) before returning the error.
  const rollbacks: Array<() => Promise<void>> = [];
  const fail = async (error: string): Promise<{ error: string }> => {
    for (const undo of rollbacks.reverse()) {
      try {
        await undo();
      } catch {
        // Best-effort: a failed compensation must not mask the original error.
      }
    }
    return { error };
  };

  // Reuse the existing fan account (top-up) or create a new one.
  let fanId = opts.fanId;
  let token: string;
  let passId: string;

  if (fanId) {
    // The fan must belong to THIS creator before we mint or top up a pass for it:
    // reject a foreign fan id up front so we never insert a fan_pass under our own
    // creator_id that points at another tenant's fan (defense in depth on top of RLS).
    const { data: ownFan } = await sb
      .from("fans")
      .select("id")
      .eq("id", fanId)
      .eq("creator_id", user.id)
      .maybeSingle();
    if (!ownFan) return { error: "fan_not_found" };
    // Existing fan: find this fan's pass FOR THIS WHEEL. Top it up if it exists,
    // otherwise mint a new per-wheel link. Spins live on the pass, not the fan.
    const { data: existing } = await sb
      .from("fan_passes")
      .select("id, token, spins_remaining, spins_granted_total")
      .eq("fan_id", fanId)
      .eq("wheel_id", wheelId)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    const ex = existing as
      | { id: string; token: string; spins_remaining: number; spins_granted_total: number }
      | null;
    if (ex) {
      passId = ex.id;
      token = ex.token;
      const exId = ex.id;
      type PassBal = { spins_remaining: number; spins_granted_total: number };
      // Compare-and-swap on the balance just read: claim_spin runs concurrently,
      // and a spin landing between our read and an absolute write would be
      // overwritten (the fan gets it back for free). A miss re-reads and retries.
      let cur: PassBal | null = ex;
      let topped = false;
      for (let attempt = 0; attempt < 3 && !topped; attempt++) {
        if (attempt > 0) {
          const { data: again } = await sb
            .from("fan_passes")
            .select("spins_remaining, spins_granted_total")
            .eq("id", exId)
            .maybeSingle();
          cur = again as PassBal | null;
          if (!cur) return fail("db_error");
        }
        const { data: updated, error: topUpErr } = await sb
          .from("fan_passes")
          .update({
            spins_remaining: cur.spins_remaining + balanceAdd,
            spins_granted_total: cur.spins_granted_total + balanceAdd,
            ...(campaignId ? { campaign_id: campaignId } : {}),
          })
          .eq("id", exId)
          .eq("spins_remaining", cur.spins_remaining)
          .eq("spins_granted_total", cur.spins_granted_total)
          .select("id")
          .maybeSingle();
        if (topUpErr) return fail("db_error");
        topped = !!updated;
      }
      if (!topped) return fail("db_error"); // balance kept moving under us
      // Undo the top-up if a later write fails: subtract balanceAdd from the
      // balance as it is THEN (a spin may have landed since), with the same
      // compare-and-swap, so the rollback never refunds a spin. Skipped (and
      // logged) if the fan already spent more than the top-up.
      rollbacks.push(async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          const { data: now } = await sb
            .from("fan_passes")
            .select("spins_remaining, spins_granted_total")
            .eq("id", exId)
            .maybeSingle();
          const c = now as PassBal | null;
          if (!c || c.spins_remaining - balanceAdd < 0) break;
          const { data: undone } = await sb
            .from("fan_passes")
            .update({
              spins_remaining: c.spins_remaining - balanceAdd,
              spins_granted_total: c.spins_granted_total - balanceAdd,
            })
            .eq("id", exId)
            .eq("spins_remaining", c.spins_remaining)
            .eq("spins_granted_total", c.spins_granted_total)
            .select("id")
            .maybeSingle();
          if (undone) return;
        }
        console.error("createPass: top-up rollback could not be applied", {
          fanId,
          passId: exId,
          balanceAdd,
        });
      });
    } else {
      token = randomToken();
      const { data: np, error: npErr } = await sb
        .from("fan_passes")
        .insert({
          token,
          creator_id: user.id,
          wheel_id: wheelId,
          fan_id: fanId,
          campaign_id: campaignId,
          spins_remaining: balanceAdd,
          spins_granted_total: balanceAdd,
        })
        .select("id")
        .single();
      if (npErr || !np) return fail("db_error");
      passId = np.id;
      const newPassId = np.id;
      rollbacks.push(async () => {
        await sb.from("fan_passes").delete().eq("id", newPassId);
      });
    }
    // The fan-level aggregate (fans.spins_remaining / spins_granted_total) is
    // owned by the 0035 trigger: the pass write above already set it to the
    // SUM of this fan's active passes, and the pass-restore rollback re-fires
    // it. Writing it here too either double-counted the spins (a re-read after
    // the pass write) or overwrote a spin that landed in between (a value read
    // before it), so there is deliberately no fans update in this branch.
  } else {
    const { data: fan, error } = await sb
      .from("fans")
      .insert({
        creator_id: user.id,
        display_name: opts.name || "Fan",
        spins_remaining: balanceAdd,
        spins_granted_total: balanceAdd,
      })
      .select("id")
      .single();
    if (error || !fan) return fail("db_error");
    fanId = fan.id;
    // Undo the new fan (cascades to its pass/grant) if a later write fails.
    const newFanId = fan.id;
    rollbacks.push(async () => {
      await sb.from("fans").delete().eq("id", newFanId);
    });

    // Referral linking (dormant feature; credit awarded on first paid grant).
    if (opts.referralCode) {
      const { data: refRow } = await sb
        .from("fans")
        .select("id")
        .eq("creator_id", user.id)
        .eq("referral_code", opts.referralCode)
        .maybeSingle();
      const referrer = refRow as { id: string } | null;
      if (referrer && referrer.id !== fanId) {
        await sb.from("fans").update({ referred_by_fan_id: referrer.id }).eq("id", fanId);
        await sb.from("referrals").insert({
          creator_id: user.id,
          referrer_fan_id: referrer.id,
          referred_fan_id: fanId,
          bonus_spins: REFERRAL_BONUS,
        });
      }
    }

    // New fan: mint their first per-wheel link with the balance on the pass.
    token = randomToken();
    const { data: np, error: passErr } = await sb
      .from("fan_passes")
      .insert({
        token,
        creator_id: user.id,
        wheel_id: wheelId,
        fan_id: fanId,
        campaign_id: campaignId,
        spins_remaining: balanceAdd,
        spins_granted_total: balanceAdd,
      })
      .select("id")
      .single();
    if (passErr || !np) return fail("db_error");
    passId = np.id;
    const newPassId2 = np.id;
    rollbacks.push(async () => {
      await sb.from("fan_passes").delete().eq("id", newPassId2);
    });
  }
  if (!fanId) return fail("db_error");

  // Record the grant for revenue, attributed to this pass (= wheel/campaign).
  const { error: grantErr } = await sb.from("grants").insert({
    creator_id: user.id,
    fan_id: fanId,
    fan_pass_id: passId,
    campaign_id: campaignId,
    spins: balanceAdd,
    amount_cents: amountCents,
    bonus_spins: bonusSpins,
  });
  // Grant failing after the fan/pass/balance writes is the exact gap the
  // rollbacks guard against: undo them so we never leave spendable spins or a
  // pass without a matching grant/revenue row.
  if (grantErr) return fail("db_error");

  // Referral crediting (idempotent): the FIRST time this fan makes a PAID
  // grant, if they were referred and haven't been credited yet, award the bonus
  // to BOTH the fan and the referrer — capped at REFERRAL_CAP credited
  // referrals per referrer. Guarded so it runs at most once.
  if (amountCents > 0) {
    const { data: meRow } = await sb
      .from("fans")
      .select("referred_by_fan_id, referral_credited")
      .eq("id", fanId)
      .maybeSingle();
    const me = meRow as {
      referred_by_fan_id: string | null;
      referral_credited: boolean;
    } | null;

    if (me && me.referred_by_fan_id && !me.referral_credited) {
      // How many referrals has the referrer already had credited?
      const { count: creditedCount } = await sb
        .from("referrals")
        .select("id", { count: "exact", head: true })
        .eq("referrer_fan_id", me.referred_by_fan_id)
        .not("credited_at", "is", null);

      if ((creditedCount ?? 0) < REFERRAL_CAP) {
        // Mark this fan credited FIRST (idempotency guard): only proceed if the
        // flag was still false at update time.
        const { data: claimed } = await sb
          .from("fans")
          .update({ referral_credited: true })
          .eq("id", fanId)
          .eq("referral_credited", false)
          .select("id")
          .maybeSingle();

        if (claimed) {
          // Credit the bonus to a SPENDABLE pass (oldest active link) for BOTH
          // the referred fan and the referrer, keeping each fan's aggregate
          // equal to the sum of its passes. Adding to fans.spins_remaining alone
          // (the old behavior) left the bonus unspendable — claim_spin
          // decrements a PASS — and inflated the displayed balance until the
          // next spin resynced it down.
          const fanCredited = await creditOldestActivePass(sb, user.id, fanId, REFERRAL_BONUS);
          const referrerCredited = await creditOldestActivePass(
            sb,
            user.id,
            me.referred_by_fan_id,
            REFERRAL_BONUS
          );
          if (!fanCredited || !referrerCredited) {
            console.error("createPass: referral bonus not credited to an active pass", {
              fanCredited,
              referrerCredited,
            });
          }

          // Mark the referral row credited.
          await sb
            .from("referrals")
            .update({
              credited_at: new Date().toISOString(),
              bonus_spins: REFERRAL_BONUS,
            })
            .eq("referred_fan_id", fanId);
        }
      }
    }
  }

  return { token, fanId };
}
