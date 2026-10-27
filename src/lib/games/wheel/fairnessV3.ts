// Fairness v3: the odds go into the commitment.
//
// v2 lets a fan prove the random seed wasn't swapped. v3 also proves which
// odds produced the result:
//   1. The server builds the spin's EFFECTIVE pool (after happy hour, with
//      sold-out prizes left out exactly as `prizeOdds` leaves them out) and
//      records it, with every modifier in force, as a canonical snapshot.
//   2. poolHash = SHA-256(canonical JSON of the snapshot).
//   3. The RNG is SHA-256(serverSeed:clientSeed:nonce:poolHash:block)
//      (`makeFairRngV3`), so changing one ticket changes every random number.
//   4. The prize is drawn FROM THE SNAPSHOT by `drawFromSnapshot`, the same
//      pure function the verify page replays with (`replayV3`). The server and
//      the verifier cannot disagree about how a snapshot maps to a prize.
//
// The draw reuses the engine's `pickPrizeWithPity` unchanged, so the odds and
// the distribution are exactly what they were; only the order the prizes are
// walked in (by id, for a canonical form) and the floats differ.
//
// Privacy: the snapshot is built from the fan-safe `PublicPrize` projection and
// keeps only id, label, emoji, rarity and the effective weight. It is shown on
// the public verify page, so it must never carry a cost or any other
// creator-private field.
import type { Rarity, WheelConfig } from "./types";
import { RARITY_ORDER } from "./types";
import { PITY_THRESHOLD, applyRareBoost, availablePrizes, pickPrizeWithPity } from "./engine";
import { makeFairRngV3, sha256Hex } from "./fairness";
import { toPublicPrize } from "./publicView";

/**
 * The fairness version new spins are recorded with. 3 = odds in the
 * commitment. Setting it to 2 is the rollback switch: new spins then use the
 * v2 derivation (seed only) and record no snapshot, and verify as v2 spins do.
 */
export const NEW_SPIN_FAIR_VERSION: 2 | 3 = 3;

/** Which game drew the prize. RM-7 adds "scratch" and "bingo". */
export type GameKind = "wheel";
export const GAME_KINDS: readonly GameKind[] = ["wheel"];

/** One prize as it stood in the pool for this spin. */
export interface SnapshotPrize {
  id: string;
  label: string;
  emoji: string | null;
  rarity: Rarity;
  /** Effective integer weight (tickets) used for the draw, after modifiers. */
  w: number;
}

/**
 * Everything that changed the odds for this spin. Every key is always present
 * so an absent modifier is an explicit null/neutral value, never a missing key.
 */
export interface SnapshotModifiers {
  /** Happy hour: rare-or-better weights scaled by this multiplier. */
  happyHour: { multiplier: number } | null;
  /** The fan's pity state going into the spin. */
  pity: { counter: number; threshold: number };
  /** #25 focus pack. Null until focus ships; this verifier refuses any other value. */
  focus: null;
  /** #25 chase pity. Null until chase ships; this verifier refuses any other value. */
  chase: null;
}

export interface PoolSnapshot {
  v: 3;
  game: GameKind;
  /** Available prizes only, ordered by id. */
  prizes: SnapshotPrize[];
  modifiers: SnapshotModifiers;
}

/**
 * Facts recorded while the spin ran, after the RNG was fixed, so they can't be
 * part of the hash: limited prizes that were drawn but had just sold out
 * (the stock compare-and-swap lost), in order, and the prize finally won. The
 * replay re-checks each one: an exclusion only stands if the RNG really drew
 * that prize at that step.
 */
export interface FairTrace {
  excluded: string[];
  won: string;
}

// ---------------------------------------------------------------------------
// Canonical JSON
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON: object keys sorted (UTF-16 code-unit order) at every
 * level, arrays kept in order, no whitespace, undefined keys dropped.
 * Non-finite numbers are refused rather than silently becoming null.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonicalJson: non-finite number");
      return JSON.stringify(value);
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof value}`);
  }
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// ---------------------------------------------------------------------------
// Building + hashing (server side)
// ---------------------------------------------------------------------------

/**
 * The spin's effective pool as a canonical snapshot. `config` is the wheel as
 * read from the database; the happy-hour boost is applied here so the mock and
 * Supabase paths derive the pool in exactly one place.
 */
export function buildPoolSnapshot(
  config: WheelConfig,
  opts: { happyHourMultiplier: number | null; pityCounter: number; pityThreshold?: number; game?: GameKind },
): PoolSnapshot {
  const m = opts.happyHourMultiplier;
  const effective = m !== null ? applyRareBoost(config, m) : config;
  const prizes = availablePrizes(effective)
    .map((p) => toPublicPrize(p, { showStock: false }))
    .map((p) => ({
      id: p.id,
      label: p.label,
      emoji: p.emoji ?? null,
      rarity: p.rarity,
      w: Math.max(0, p.weight),
    }))
    .sort(byId);
  return {
    v: 3,
    game: opts.game ?? "wheel",
    prizes,
    modifiers: {
      happyHour: m !== null ? { multiplier: m } : null,
      pity: { counter: opts.pityCounter, threshold: opts.pityThreshold ?? PITY_THRESHOLD },
      focus: null,
      chase: null,
    },
  };
}

/** SHA-256 (lowercase hex) of the snapshot's canonical JSON. */
export async function hashPoolSnapshot(snapshot: PoolSnapshot): Promise<string> {
  return sha256Hex(canonicalJson(snapshot));
}

/**
 * Draw one prize from the snapshot, honouring pity, skipping `excluded` ids
 * (prizes that sold out mid-spin). Throws when nothing is left to draw, like
 * `pickPrize`. The server and `replayV3` both call this.
 */
export function drawFromSnapshot(
  snapshot: PoolSnapshot,
  excluded: ReadonlySet<string>,
  rng: () => number,
): { prize: SnapshotPrize; pityAwarded: boolean; nextPityCounter: number } {
  const config: WheelConfig = {
    id: "snapshot",
    title: "snapshot",
    prizes: snapshot.prizes.map((p) => ({
      id: p.id,
      label: p.label,
      rarity: p.rarity,
      weight: p.w,
      stock: excluded.has(p.id) ? 0 : null,
    })),
  };
  const pick = pickPrizeWithPity(
    config,
    { pityCounter: snapshot.modifiers.pity.counter, pityThreshold: snapshot.modifiers.pity.threshold },
    rng,
  );
  return {
    prize: snapshot.prizes[pick.index],
    pityAwarded: pick.pityAwarded,
    nextPityCounter: pick.nextPityCounter,
  };
}

/**
 * The odds that were in force for the first draw, per prize, in snapshot
 * order. When the pity guarantee was due and a rare-or-better prize was
 * available, only those prizes could land (mirrors `pickPrizeWithPity`).
 */
export function snapshotOdds(snapshot: PoolSnapshot): {
  pityForced: boolean;
  rows: { prize: SnapshotPrize; chance: number }[];
} {
  const { counter, threshold } = snapshot.modifiers.pity;
  const rare = (r: Rarity) => RARITY_ORDER.indexOf(r) >= RARITY_ORDER.indexOf("rare");
  const rarePool = snapshot.prizes.filter((p) => rare(p.rarity));
  const pityForced = counter + 1 >= threshold && rarePool.length > 0;
  const pool = pityForced ? rarePool : snapshot.prizes;
  const total = pool.reduce((s, p) => s + p.w, 0);
  return {
    pityForced,
    rows: snapshot.prizes.map((prize) => {
      const inPool = pool.includes(prize);
      const chance = !inPool ? 0 : total > 0 ? prize.w / total : 1 / pool.length;
      return { prize, chance };
    }),
  };
}

// ---------------------------------------------------------------------------
// Parsing + replay (verify side)
// ---------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const exactKeys = (o: Record<string, unknown>, keys: string[]) =>
  Object.keys(o).length === keys.length && keys.every((k) => k in o);
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

export type SnapshotParse = { ok: true; snapshot: PoolSnapshot } | { ok: false; reason: string };

/**
 * Validate a stored snapshot and return it in canonical form (prizes by id).
 * Strict: an unknown key, a non-integer weight or a modifier this verifier
 * does not implement is refused, so nothing in the hashed record can be
 * silently ignored by the replay.
 */
export function parsePoolSnapshot(raw: unknown): SnapshotParse {
  const bad = (reason: string): SnapshotParse => ({ ok: false, reason });
  if (!isObj(raw) || !exactKeys(raw, ["v", "game", "prizes", "modifiers"])) return bad("unreadable snapshot");
  if (raw.v !== 3) return bad("unsupported snapshot version");
  if (!GAME_KINDS.includes(raw.game as GameKind)) return bad("unsupported game");
  if (!Array.isArray(raw.prizes) || raw.prizes.length === 0) return bad("snapshot has no prizes");
  const prizes: SnapshotPrize[] = [];
  const ids = new Set<string>();
  for (const p of raw.prizes) {
    if (!isObj(p) || !exactKeys(p, ["id", "label", "emoji", "rarity", "w"])) return bad("unreadable prize");
    if (typeof p.id !== "string" || !p.id || ids.has(p.id)) return bad("bad prize id");
    if (typeof p.label !== "string") return bad("bad prize label");
    if (p.emoji !== null && typeof p.emoji !== "string") return bad("bad prize emoji");
    if (!RARITY_ORDER.includes(p.rarity as Rarity)) return bad("bad prize rarity");
    if (!isCount(p.w)) return bad("weights must be whole numbers");
    ids.add(p.id);
    prizes.push({ id: p.id, label: p.label, emoji: p.emoji, rarity: p.rarity as Rarity, w: p.w });
  }
  const m = raw.modifiers;
  if (!isObj(m) || !exactKeys(m, ["happyHour", "pity", "focus", "chase"])) return bad("unreadable modifiers");
  let happyHour: SnapshotModifiers["happyHour"] = null;
  if (m.happyHour !== null) {
    const h = m.happyHour;
    if (!isObj(h) || !exactKeys(h, ["multiplier"]) || typeof h.multiplier !== "number" || !Number.isFinite(h.multiplier) || h.multiplier < 1)
      return bad("bad happy-hour modifier");
    happyHour = { multiplier: h.multiplier };
  }
  const pity = m.pity;
  if (!isObj(pity) || !exactKeys(pity, ["counter", "threshold"]) || !isCount(pity.counter) || !isCount(pity.threshold) || pity.threshold < 1)
    return bad("bad pity modifier");
  if (m.focus !== null || m.chase !== null) return bad("uses a modifier this verifier doesn't support yet");
  return {
    ok: true,
    snapshot: {
      v: 3,
      game: raw.game as GameKind,
      prizes: prizes.sort(byId),
      modifiers: {
        happyHour,
        pity: { counter: pity.counter, threshold: pity.threshold },
        focus: null,
        chase: null,
      },
    },
  };
}

export function parseFairTrace(raw: unknown): FairTrace | null {
  if (!isObj(raw) || !exactKeys(raw, ["excluded", "won"])) return null;
  if (!Array.isArray(raw.excluded) || !raw.excluded.every((e) => typeof e === "string")) return null;
  if (typeof raw.won !== "string" || !raw.won) return null;
  return { excluded: [...raw.excluded], won: raw.won };
}

export interface V3ReplayInput {
  serverSeed: string;
  clientSeed: string | null;
  nonce: number;
  /** The stored snapshot, as read back (untrusted shape). */
  snapshot: unknown;
  /** The stored pool hash. */
  poolHash: string | null;
  /** The stored trace (untrusted shape). */
  trace: unknown;
  /** The spin row's recorded prize (id may be null if the prize was deleted later). */
  prizeId: string | null;
  prizeLabel: string;
}

export interface V3Replay {
  /** True only when the hash matches AND the replay lands on the recorded prize. */
  ok: boolean;
  snapshot: PoolSnapshot | null;
  /** SHA-256 of the stored snapshot, recomputed here. */
  computedHash: string | null;
  poolHashOk: boolean;
  /** The prize the replay landed on. */
  replayed: SnapshotPrize | null;
  /** Prizes drawn first but sold out mid-spin, in order (each re-checked). */
  excluded: SnapshotPrize[];
  pityAwarded: boolean;
  /** Plain-language reason when `ok` is false. */
  problem: string | null;
}

/**
 * Re-run a v3 spin end to end from its recorded inputs: re-hash the snapshot,
 * rebuild the RNG from (serverSeed, clientSeed, nonce, poolHash), re-draw
 * every sold-out re-pick and the final prize. Pure and deterministic.
 */
export async function replayV3(input: V3ReplayInput): Promise<V3Replay> {
  const out: V3Replay = {
    ok: false,
    snapshot: null,
    computedHash: null,
    poolHashOk: false,
    replayed: null,
    excluded: [],
    pityAwarded: false,
    problem: null,
  };
  const parsed = parsePoolSnapshot(input.snapshot);
  if (!parsed.ok) return { ...out, problem: `The recorded odds can't be read (${parsed.reason}).` };
  const snapshot = parsed.snapshot;
  out.snapshot = snapshot;
  out.computedHash = await hashPoolSnapshot(snapshot);
  out.poolHashOk = out.computedHash === input.poolHash;
  const trace = parseFairTrace(input.trace);
  if (!trace) return { ...out, problem: "The spin's draw record can't be read." };

  // The recomputed hash, not the stored one: tampered odds give different floats.
  const rng = await makeFairRngV3(input.serverSeed, input.clientSeed ?? "", input.nonce, out.computedHash);
  const byIdMap = new Map(snapshot.prizes.map((p) => [p.id, p]));
  const excluded = new Set<string>();
  try {
    for (const id of trace.excluded) {
      const draw = drawFromSnapshot(snapshot, excluded, rng);
      if (draw.prize.id !== id) {
        return { ...out, problem: "A recorded sold-out re-draw doesn't match what these seeds and odds draw." };
      }
      excluded.add(id);
      out.excluded.push(byIdMap.get(id)!);
    }
    const final = drawFromSnapshot(snapshot, excluded, rng);
    out.replayed = final.prize;
    out.pityAwarded = final.pityAwarded;
  } catch {
    return { ...out, problem: "These odds leave nothing to draw." };
  }

  if (!out.poolHashOk) {
    return { ...out, problem: "The recorded odds don't match their fingerprint, so they were changed after the spin." };
  }
  const landed = out.replayed;
  if (!landed) return { ...out, problem: "These odds leave nothing to draw." };
  const matches =
    landed.id === trace.won &&
    (input.prizeId === null || input.prizeId === trace.won) &&
    landed.label === input.prizeLabel;
  if (!matches) {
    return { ...out, problem: "Replaying these seeds and odds lands on a different prize than the one recorded." };
  }
  return { ...out, ok: true };
}
