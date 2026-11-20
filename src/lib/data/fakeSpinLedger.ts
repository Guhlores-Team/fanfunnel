// Test-only, in-memory stand-in for the 0059 attempt ledger behind
// `commitSpinAttempt` (./spinAttempts.ts): prepare_spin_attempt,
// commit_spin_attempt, cancel_spin_attempt, get_spin_attempt_status,
// get_fan_focus_state and record_fan_reward_views, plus the few table reads the
// live path makes around a commit (sealed reward candidates, play counts).
//
// It models the database rules the live path depends on, each inside ONE
// commit: the balance is spent exactly once per request id; a limited prize's
// stock is taken by at most `stock` commits (the loser gets `sold_out` and
// redraws); a code prize binds one unused code per spin; a link/text prize must
// still carry the sealed value the TS side decrypted (`changed` otherwise); a
// committed receipt is immutable and replays for the same request id. Nothing
// here ever refunds, decrements or writes outside `commit_spin_attempt`, so a
// test that sees a split write is seeing a bug in the code under test.
//
// Every rpc call runs synchronously once awaited, which is exactly the
// atomicity a Postgres transaction gives the real function: concurrent spins
// interleave only between calls, never inside one.
import { sha256Hex } from "@/lib/games/wheel/fairness";
import type { createServiceClient } from "@/lib/supabase/server";

export type Op = { name: string; args: unknown[] };
export type Resp = { data: unknown; error: { message: string; code?: string } | null; count?: number | null };
export type TableHandler = (ops: Op[]) => Resp;
export const ok = (data: unknown): Resp => ({ data, error: null });
export const has = (ops: Op[], name: string, arg?: string) =>
  ops.some((o) => o.name === name && (arg === undefined || String(o.args[0]).includes(arg)));

export interface LedgerPrize {
  id: string;
  label?: string;
  rarity?: "common" | "rare" | "epic" | "legendary";
  weight: number;
  /** null = unlimited. */
  stock: number | null;
  delivery?: "manual" | "link" | "text" | "codes";
  cost_cents?: number | null;
  description?: string | null;
  image_url?: string | null;
}
export interface SealedValue { cipher: string; iv: string; keyVersion: number }
export interface LedgerOptions {
  creatorId?: string;
  fanId?: string;
  passId?: string;
  wheelId?: string;
  balance?: number;
  pityCounter?: number;
  happyHourMultiplier?: number | null;
  showStock?: boolean;
  /** "fresh": the pass holds no committed seed (seed_commitment = fresh). */
  commitment?: "stored" | "fresh";
  gameReady?: boolean;
  /** Sealed link/text rewards by prize id (kind from the prize's delivery). */
  rewards?: Record<string, SealedValue>;
  /** Sealed codes by prize id, in pool order. */
  codes?: Record<string, SealedValue[]>;
  /** Extra table reads (webhooks, push devices, ...): same shape as the older fakes. */
  tables?: Record<string, TableHandler>;
}
export interface Receipt {
  status: "committed";
  replayed: boolean;
  id: string;
  shareId: string;
  spin: Record<string, unknown>;
  prize: unknown;
  prizeIndex: number;
  showStock: boolean;
  stockAfter: number | null;
  balance: number;
  nextServerSeedHash: string;
  focus: null;
  pityAwarded: boolean;
  focusConsumed: boolean;
  chaseConsumed: boolean;
  chaseCompleted: boolean;
  chaseAwarded: boolean;
  reward: { kind: "link" | "text" | "code"; cipher: string; iv: string; keyVersion: number } | null;
}
export type Reply = { data: unknown; error: { code?: string; message?: string } | null };
export type RpcCall = { name: string; args: Record<string, unknown> };

let codeSeq = 0;

export class FakeSpinLedger {
  readonly creatorId: string;
  readonly fanId: string;
  readonly passId: string;
  readonly wheelId: string;
  balance: number;
  nonce = 0;
  pityCounter: number;
  seed: string;
  seedHash = "";
  commitment: "stored" | "fresh";
  happyHourMultiplier: number | null;
  gameReady: boolean;
  readonly wheel: Record<string, unknown>;
  readonly prizes: Record<string, unknown>[];
  /** Current free stock per limited prize id (what the live read projects). */
  readonly stock = new Map<string, number | null>();
  readonly codes = new Map<string, { id: string; prizeId: string; cipher: string; iv: string; key_version: number; spinId: string | null }>();
  readonly rewards = new Map<string, { kind: string; cipher: string; iv: string; key_version: number }>();
  readonly receipts = new Map<string, Receipt>();
  readonly spinRows: Record<string, unknown>[] = [];
  readonly redemptions: { spin_id: string; status: "pending" | "fulfilled" }[] = [];
  readonly rpcs: RpcCall[] = [];
  readonly reads: { table: string; ops: Op[] }[] = [];
  /** Lose the response of the next successful commit (the receipt is stored). */
  loseNextCommitResponse = false;
  /** Fail the next N commit transports outright (nothing is stored). */
  failCommitTransports = 0;
  /** Fail the next prepare transport. */
  failNextPrepare = false;
  /** Answer every prepare with this reply (e.g. the pass vanished, no wheel resolves). */
  prepareReply: Record<string, unknown> | null = null;
  /** Answer `changed` to the next commit (sealed value edited meanwhile). */
  changedOnce = false;
  /** Answer every commit (and cancel) with this reply, e.g. `unavailable` when the link/fan/creator went inactive. */
  commitReply: Record<string, unknown> | null = null;
  /** Answer every status read with this reply (0073: `not_found`, declined/`stale`). */
  statusReply: Record<string, unknown> | null = null;
  /** Answer `retry_context` to the next commit. */
  retryContextOnce = false;
  /** Fail reads of this table once (unknown transport) — the sealed candidate read. */
  failNextReadOf: string | null = null;
  /** Called before each commit's checks: lets a test race another commit in. */
  beforeCommit: ((args: Record<string, unknown>) => void | Promise<void>) | null = null;
  private tables: Record<string, TableHandler>;
  private stockWrites = 0;

  constructor(prizes: LedgerPrize[], opts: LedgerOptions = {}) {
    this.creatorId = opts.creatorId ?? "creator-1";
    this.fanId = opts.fanId ?? "fan-1";
    this.passId = opts.passId ?? "pass-1";
    this.wheelId = opts.wheelId ?? "wheel-1";
    this.balance = opts.balance ?? 5;
    this.pityCounter = opts.pityCounter ?? 0;
    this.happyHourMultiplier = opts.happyHourMultiplier ?? null;
    this.commitment = opts.commitment ?? "stored";
    this.gameReady = opts.gameReady ?? true;
    this.seed = "a".repeat(64);
    this.tables = opts.tables ?? {};
    this.wheel = {
      id: this.wheelId, title: "Live wheel", subtitle: null, brand_color: "#ec4899", label_color: null, label_size: null,
      show_stock: opts.showStock ?? true, is_active: true, active_from: null, active_until: null, archived_at: null,
      game_ready: this.gameReady, game_kind: "wheel", game_config: null,
    };
    this.prizes = prizes.map((p, i) => ({
      id: p.id, label: p.label ?? p.id, description: p.description ?? null, rarity: p.rarity ?? "common", weight: p.weight,
      color: null, emoji: null, image_url: p.image_url ?? null, cost_cents: p.cost_cents ?? null, stock: p.stock,
      sort_order: i, delivery: p.delivery ?? "manual", boostable: false,
    }));
    for (const p of prizes) this.stock.set(p.id, p.stock);
    for (const [prizeId, sealed] of Object.entries(opts.rewards ?? {})) {
      const prize = prizes.find((p) => p.id === prizeId);
      this.rewards.set(prizeId, { kind: prize?.delivery === "text" ? "text" : "link", cipher: sealed.cipher, iv: sealed.iv, key_version: sealed.keyVersion });
    }
    for (const [prizeId, list] of Object.entries(opts.codes ?? {})) {
      for (const sealed of list) {
        const id = `code-${++codeSeq}`;
        this.codes.set(id, { id, prizeId, cipher: sealed.cipher, iv: sealed.iv, key_version: sealed.keyVersion, spinId: null });
      }
    }
  }

  /** Must be awaited once before the first spin (the committed hash). */
  async init(): Promise<this> {
    this.seedHash = await sha256Hex(this.seed);
    return this;
  }

  /** How many commits touched a limited prize's stock (contention evidence). */
  writes(): number {
    return this.stockWrites;
  }

  freeCodes(prizeId: string): number {
    return [...this.codes.values()].filter((c) => c.prizeId === prizeId && c.spinId === null).length;
  }

  private livePrizes(): Record<string, unknown>[] {
    return this.prizes.map((p) => ({ ...p, stock: this.stock.get(String(p.id)) ?? null }));
  }

  private context() {
    return {
      contextHash: `ctx-${this.nonce}`, creatorId: this.creatorId, fanId: this.fanId, passId: this.passId, wheelId: this.wheelId,
      campaignId: null, serverSeed: this.seed, serverSeedHash: this.seedHash, nonce: this.nonce, pityCounter: this.pityCounter,
      happyHourMultiplier: this.happyHourMultiplier, commitment: this.commitment, focus: null, reservation: null,
      wheel: { ...this.wheel, game_ready: this.gameReady }, prizes: this.livePrizes(),
    };
  }

  private replay(id: string): Receipt | null {
    const r = this.receipts.get(id);
    return r ? { ...structuredClone(r), replayed: true, balance: this.balance, nextServerSeedHash: this.seedHash } : null;
  }

  private query(table: string) {
    const ops: Op[] = [];
    const run = (): Resp => {
      this.reads.push({ table, ops });
      if (this.failNextReadOf === table) {
        this.failNextReadOf = null;
        return { data: null, error: { message: "connection reset" } };
      }
      const custom = this.tables[table];
      if (custom) return custom(ops);
      return this.read(table, ops);
    };
    const proxy: unknown = new Proxy({}, {
      get: (_t, prop) => {
        if (prop === "then") return (res: (v: Resp) => unknown, rej: (e: unknown) => unknown) => Promise.resolve().then(run).then(res, rej);
        return (...args: unknown[]) => { ops.push({ name: String(prop), args }); return proxy; };
      },
    });
    return proxy;
  }

  private read(table: string, ops: Op[]): Resp {
    const eq = (col: string) => ops.find((o) => o.name === "eq" && o.args[0] === col)?.args[1];
    switch (table) {
      case "prize_reward_codes": {
        const prizeId = String(eq("prize_id"));
        const notIn = ops.find((o) => o.name === "not" && o.args[0] === "id");
        const excluded = notIn ? String(notIn.args[2]).replace(/[()]/g, "").split(",").filter(Boolean) : [];
        const wantId = eq("id");
        const row = [...this.codes.values()].find((c) => c.prizeId === prizeId && c.spinId === null && !excluded.includes(c.id) && (wantId === undefined || c.id === wantId));
        return ok(row ? { id: row.id, cipher: row.cipher, iv: row.iv, key_version: row.key_version } : null);
      }
      case "prize_rewards": {
        const row = this.rewards.get(String(eq("prize_id")));
        return ok(row ? { kind: row.kind, cipher: row.cipher, iv: row.iv, key_version: row.key_version } : null);
      }
      case "fan_play_reminders":
        return ok(null);
      case "spins": {
        const n = this.spinRows.filter((s) => s.fan_id === this.fanId).length;
        return { data: null, error: null, count: n };
      }
      default:
        return has(ops, "maybeSingle") ? ok(null) : { data: [], error: null, count: 0 };
    }
  }

  async rpc(name: string, args: Record<string, unknown>): Promise<Reply> {
    this.rpcs.push({ name, args: structuredClone(args) });
    const id = String(args.p_attempt ?? "");
    switch (name) {
      case "can_act_for":
        return ok(true);
      case "get_fan_focus_state":
        return ok({ status: "ok", focus: null, context: { wheel: this.wheel, prizes: this.livePrizes(), pityCounter: this.pityCounter, happyHourMultiplier: this.happyHourMultiplier, reserved: false } });
      case "record_fan_reward_views":
        return ok((args.p_spins as unknown[]).length);
      case "get_spin_attempt_status":
        if (this.statusReply) return ok(structuredClone(this.statusReply));
        return ok(this.replay(id) ?? { status: "absent" });
      case "cancel_spin_attempt": {
        if (this.commitReply) return ok(structuredClone(this.commitReply));
        const done = this.replay(id);
        if (done) return ok(done);
        return ok({ status: "declined", error: args.p_error ?? "no_prizes" });
      }
      case "prepare_spin_attempt": {
        if (this.failNextPrepare) { this.failNextPrepare = false; return { data: null, error: { code: "PGRST_CONNECTION" } }; }
        if (this.prepareReply) return ok(structuredClone(this.prepareReply));
        const done = this.replay(id);
        if (done) return ok(done);
        if (this.balance <= 0) return ok({ status: "declined", error: "no_spins" });
        return ok({ status: "ready", context: this.context(), balance: this.balance });
      }
      case "commit_spin_attempt":
        return this.commit(id, args);
      default:
        throw new Error(`fakeSpinLedger: rpc ${name} is not modelled (a split write?)`);
    }
  }

  private async commit(id: string, args: Record<string, unknown>): Promise<Reply> {
    if (this.beforeCommit) await this.beforeCommit(args);
    if (this.commitReply) return ok(structuredClone(this.commitReply));
    const done = this.replay(id);
    if (done) return ok(done);
    if (this.failCommitTransports > 0) { this.failCommitTransports--; return { data: null, error: { code: "PGRST_CONNECTION" } }; }
    if (this.retryContextOnce) { this.retryContextOnce = false; return ok({ status: "retry_context" }); }
    const ctx = args.p_context as { contextHash: string; publishedSeedHash: string | null };
    if (ctx.contextHash !== `ctx-${this.nonce}`) return ok({ status: "retry_context" });
    const spin = args.p_spin as Record<string, unknown>;
    const prizeId = String(spin.prize_id);
    const expected = args.p_expected_reward as { delivery: string; codeId?: string; cipher?: string };
    // Stock and reward binding, atomically with the spin row.
    const left = this.stock.get(prizeId);
    if (typeof left === "number") {
      this.stockWrites++;
      if (left <= 0) return ok({ status: "sold_out" });
    }
    let reward: Receipt["reward"] = null;
    let code: { id: string; spinId: string | null; cipher: string; iv: string; key_version: number } | undefined;
    if (expected.delivery === "codes") {
      code = expected.codeId ? this.codes.get(expected.codeId) : undefined;
      if (!code || code.spinId !== null) return ok({ status: "sold_out" });
      reward = { kind: "code", cipher: code.cipher, iv: code.iv, keyVersion: code.key_version };
    } else if (expected.delivery === "link" || expected.delivery === "text") {
      const row = this.rewards.get(prizeId);
      if (this.changedOnce) { this.changedOnce = false; return ok({ status: "changed" }); }
      if (!row || row.kind !== expected.delivery || row.cipher !== expected.cipher) return ok({ status: "changed" });
      reward = { kind: row.kind as "link" | "text", cipher: row.cipher, iv: row.iv, keyVersion: row.key_version };
    }
    // Every write below is one transaction.
    if (typeof left === "number") this.stock.set(prizeId, left - 1);
    if (code) code.spinId = id;
    this.balance--;
    this.nonce++;
    this.pityCounter = Number(spin.next_pity_counter) || 0;
    const next = args.p_next_seed as { seed: string; hash: string };
    this.seed = next.seed;
    this.seedHash = next.hash;
    const row = { ...spin, created_at: "2026-10-28T00:00:00Z", kind: "play" };
    this.spinRows.push(row);
    this.redemptions.push({ spin_id: id, status: reward ? "fulfilled" : "pending" });
    const receipt: Receipt = {
      status: "committed", replayed: false, id, shareId: `share-${id}`, spin: row, prize: spin.response_prize,
      prizeIndex: Number(spin.response_prize_index), showStock: spin.response_show_stock === true,
      stockAfter: typeof left === "number" ? left - 1 : null, balance: this.balance, nextServerSeedHash: this.seedHash, focus: null,
      pityAwarded: spin.pity_awarded === true, focusConsumed: false, chaseConsumed: false, chaseCompleted: false, chaseAwarded: false, reward,
    };
    this.receipts.set(id, structuredClone(receipt));
    if (this.loseNextCommitResponse) { this.loseNextCommitResponse = false; return { data: null, error: { code: "PGRST_CONNECTION" } }; }
    return ok(receipt);
  }

  /** The client the code under test receives (service client shape). */
  client(): ReturnType<typeof createServiceClient> {
    return {
      from: (table: string) => this.query(table),
      rpc: (name: string, args: Record<string, unknown>) => this.rpc(name, args),
      auth: { getUser: async () => ({ data: { user: { id: this.creatorId } }, error: null }) },
    } as unknown as ReturnType<typeof createServiceClient>;
  }
}

/** A fresh intent for one spin on the ledger's current commitment. */
export function intentFor(ledger: FakeSpinLedger, clientSeed = "client"): { requestId: string; clientSeed: string; publishedSeedHash: string } {
  return { requestId: crypto.randomUUID(), clientSeed, publishedSeedHash: ledger.seedHash };
}
