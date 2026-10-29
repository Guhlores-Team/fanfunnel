// Test-only, in-memory stand-in for the slice of the supabase-js query builder
// the fan spin ledger code in ./index.ts uses (from/select/insert/update/delete,
// eq/neq/is/not/order/limit, single/maybeSingle, auth.getUser, rpc). It models
// the database rules the ledger depends on:
//   - migration 0035's trigger: after any write to fan_passes, the owning fan's
//     spins_remaining / spins_granted_total are reset to the SUM over that
//     fan's ACTIVE passes;
//   - the `fans.spins_remaining >= 0` check constraint (a statement that would
//     violate it fails and leaves the tables untouched);
//   - claim_spin's decrement, via `spin(token)`, so a test can interleave a
//     fan's spin between two of the code's statements (`beforeStatement`).
// Unit tests swap it in for `createClient()` with node:test's `mock.module`, so
// the real Supabase code path can be exercised without a database. Anything it
// does not model (an unknown rpc, limit on a write) throws instead of quietly
// succeeding, so a test can't pass on behaviour the fake made up.

export type Row = Record<string, unknown>;

export type DbError = { message: string; code?: string };
type Op = "select" | "insert" | "update" | "delete";
type Filter = { col: string; operator: string; value: unknown; test: (row: Row) => boolean };
type Result = { data: unknown; error: DbError | null; count: number | null };

/** What `beforeStatement` sees for each statement the code under test runs. */
export type Statement = {
  n: number; // 1-based position in the sequence of statements so far
  table: string;
  op: Op;
  filters: Array<{ col: string; operator: string; value: unknown }>;
  payload: Row | Row[] | null;
  /** Internal statements of an atomic RPC, never standalone client writes. */
  transaction?: boolean;
};

const TABLE_DEFAULTS: Record<string, Row> = {
  fans: {
    display_name: null,
    spins_remaining: 0,
    spins_granted_total: 0,
    referred_by_fan_id: null,
    referral_credited: false,
    blocked_at: null,
  },
  fan_passes: {
    is_active: true,
    spins_remaining: 0,
    spins_granted_total: 0,
    campaign_id: null,
    self_excluded_at: null,
    last_spin_at: null,
  },
  grants: { spins: 0, amount_cents: 0, bonus_spins: 0, campaign_id: null, fan_pass_id: null },
  wheels: { is_active: false, archived_at: null, game_ready: true },
  campaigns: { pinned_wheel_id: null },
};

export class FakeSupabase {
  readonly tables: Record<string, Row[]> = {
    fans: [],
    fan_passes: [],
    grants: [],
    wheels: [],
    campaigns: [],
    campaign_packs: [],
    referrals: [],
    spins: [],
    redemptions: [],
  };
  /** Every statement executed so far, in order (for assertions on sequencing). */
  readonly statements: Statement[] = [];
  /** rpc handlers a test registers; an unregistered rpc name throws. */
  readonly rpcHandlers: Record<string, (args: unknown) => unknown> = {};
  /**
   * Runs before each statement. Return a DbError to make that statement fail
   * (nothing is written); mutate the store (e.g. `spin(token)`) to model a
   * concurrent writer landing between two of the code's round trips.
   */
  beforeStatement: ((stmt: Statement) => DbError | void) | null = null;
  private seq = 0;
  enforceAtomicEconomy = false;
  readonly permissions: Record<string, boolean> = {};
  readonly rpcCalls: { name: string; args: Row }[] = [];
  private economicRequests = new Map<string, { intent: string; receipt: Row }>();

  constructor(readonly userId: string) {}

  /** Insert a row directly (test setup), applying table defaults + id/created_at. */
  seed(table: string, row: Row): Row {
    const full = this.withDefaults(table, row);
    this.rows(table).push(full);
    if (table === "fan_passes") this.syncAggregate(full.fan_id as string);
    return full;
  }

  rows(table: string): Row[] {
    const t = this.tables[table];
    if (!t) throw new Error(`fakeSupabase: unknown table ${table}`);
    return t;
  }

  row(table: string, id: string): Row {
    const r = this.rows(table).find((x) => x.id === id);
    if (!r) throw new Error(`fakeSupabase: no ${table} row ${id}`);
    return r;
  }

  /** SUM(spins_remaining) over a fan's active passes — the ledger invariant's RHS. */
  sumPasses(fanId: string, col = "spins_remaining"): number {
    return this.rows("fan_passes")
      .filter((p) => p.fan_id === fanId && p.is_active === true)
      .reduce((s, p) => s + (p[col] as number), 0);
  }

  /**
   * claim_spin (0035): spend one spin from the pass behind `token` and let the
   * trigger resync the fan. Returns the pass's new balance, or null when the
   * token is unknown/inactive/empty.
   */
  spin(token: string): number | null {
    const p = this.rows("fan_passes").find((x) => x.token === token && x.is_active === true);
    if (!p || (p.spins_remaining as number) <= 0) return null;
    p.spins_remaining = (p.spins_remaining as number) - 1;
    p.last_spin_at = new Date().toISOString();
    this.syncAggregate(p.fan_id as string);
    return p.spins_remaining as number;
  }

  /** The object the code under test receives from `createClient()`. */
  client() {
    return {
      auth: {
        getUser: async () => ({ data: { user: { id: this.userId } }, error: null }),
      },
      from: (table: string) => new Query(this, table),
      rpc: async (name: string, args: unknown) => {
        this.rpcCalls.push({ name, args: args as Row });
        const handler = this.rpcHandlers[name];
        if (handler) return { data: handler(args) ?? null, error: null };
        try { return { data: this.economicRpc(name, args as Row), error: null }; }
        catch (error) {
          if (error && typeof error === "object" && "message" in error) return { data: null, error: { code: "P0001", ...error } };
          throw error;
        }
      },
    };
  }

  /** Before-lock probes model a separately committed concurrent spin. No
   * uncommitted credit is exposed to spin(), even when a later SQL write fails. */
  private probe(table: string, op: Op, payload: Row | null, equals: Row = {}) {
    const statement: Statement = { n: this.statements.length + 1, table, op, payload, transaction: true, filters: Object.entries(equals).map(([col, value]) => ({ col, operator: "eq", value })) };
    this.statements.push(statement);
    const error = this.beforeStatement?.(statement);
    if (error) throw error;
  }
  private eligible(fan: Row | undefined): boolean {
    return !!fan && !fan.blocked_at && (!fan.break_until || Date.parse(String(fan.break_until)) <= Date.now());
  }
  private oldest(fanId: unknown): Row | undefined {
    return this.rows("fan_passes").filter(p => p.fan_id === fanId && p.is_active && !p.self_excluded_at)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)))[0];
  }
  private economicRpc(name: string, args: Row): unknown {
    if (name === "can_act_for") return this.permissions[String(args.target_creator)] ?? args.target_creator === this.userId;
    if (!["grant_pass_spins", "create_pass_grant", "edit_pass_grant", "award_fan_referral"].includes(name)) throw new Error(`fakeSupabase: rpc ${name} is not modelled`);
    const creator = args.p_creator;
    if (name === "award_fan_referral") {
      const fan = this.rows("fans").find(f => f.id === args.p_fan && f.creator_id === creator);
      if (!fan) return { status: "unavailable" };
      if (fan.referral_credited) return { status: "already_credited" };
      const referrer = this.rows("fans").find(f => f.id === fan.referred_by_fan_id && f.creator_id === creator);
      const referral = this.rows("referrals").find(r => r.referred_fan_id === fan.id && r.referrer_fan_id === referrer?.id && r.creator_id === creator);
      if (!referral || !referrer || referrer.id === fan.id || !this.rows("grants").some(g => g.fan_id === fan.id && Number(g.amount_cents) > 0)) return { status: "pending" };
      if (this.rows("referrals").filter(r => r.referrer_fan_id === referrer.id && r.credited_at).length >= 3) return { status: "capped" };
      const pass = this.oldest(fan.id), refPass = this.oldest(referrer.id);
      if (!this.eligible(fan) || !this.eligible(referrer) || !pass || !refPass) return { status: "pending" };
      for (const p of [pass, refPass]) this.probe("fan_passes", "update", { spins_remaining: Number(p.spins_remaining) + 3 }, { id: p.id });
      this.probe("referrals", "update", { credited_at: "now" }, { id: referral.id });
      for (const p of [pass, refPass]) { p.spins_remaining = Number(p.spins_remaining) + 3; p.spins_granted_total = Number(p.spins_granted_total) + 3; this.syncAggregate(String(p.fan_id)); }
      fan.referral_credited = true; referral.credited_at = new Date().toISOString(); referral.bonus_spins = 3;
      return { status: "credited" };
    }
    if (name === "edit_pass_grant") {
      if (typeof args.p_request !== "string" || args.p_actor !== this.userId || !args.p_patch || typeof args.p_patch !== "object") throw new Error("durable edit identity required");
      const patch = args.p_patch as Row;
      const request = `edit:${args.p_actor}:${args.p_request}`;
      const intent = JSON.stringify([creator, args.p_grant, Object.keys(patch).sort().map(key => [key, patch[key]])]);
      const previous = this.economicRequests.get(request);
      const grant = this.rows("grants").find(g => g.id === args.p_grant && g.creator_id === creator);
      const current = (replayed: boolean) => {
        if (!grant || !this.rows("fans").some(f => f.id === grant.fan_id && f.creator_id === creator)) return { status: "gone", error: "gone" };
        const pass = this.rows("fan_passes").find(p => p.id === grant.fan_pass_id && p.is_active && !p.self_excluded_at) ?? this.oldest(grant.fan_id);
        return { status: "updated", grantId: grant.id, replayed, balance: pass?.spins_remaining ?? null, grant: { id: grant.id, spins: grant.spins, bonusSpins: grant.bonus_spins, amountCents: grant.amount_cents, campaignId: grant.campaign_id } };
      };
      if (previous) return previous.intent !== intent ? { status: "conflict" } : previous.receipt.status === "updated" ? current(true) : { ...previous.receipt };
      const finish = (receipt: Row) => { this.economicRequests.set(request, { intent, receipt }); return receipt; };
      if (!(this.permissions[String(creator)] ?? creator === this.userId)) return finish({ status: "unavailable", error: "forbidden" });
      if (!grant) return finish({ status: "unavailable", error: "not_found" });
      if (Object.hasOwn(patch, "campaignId") && patch.campaignId !== null && !this.rows("campaigns").some(c => c.id === patch.campaignId && c.creator_id === creator)) return finish({ status: "invalid", error: "campaign_not_found" });
      this.probe("fan_passes", "select", null, { fan_id: grant.fan_id });
      const pass = this.rows("fan_passes").find(p => p.id === grant.fan_pass_id && p.is_active && !p.self_excluded_at) ?? this.oldest(grant.fan_id);
      const total = Object.hasOwn(patch, "spins") ? Number(patch.spins) : Number(grant.spins);
      const delta = total - Number(grant.spins);
      if (!pass && delta) return finish({ status: "invalid", error: "no_active_pass" });
      const fan = this.rows("fans").find(f => f.id === grant.fan_id);
      if (delta > 0 && !this.eligible(fan)) return finish({ status: "unavailable", error: fan?.blocked_at ? "blocked" : fan?.break_until ? "on_break" : "not_found" });
      if (delta && pass) this.probe("fan_passes", "update", { spins_remaining: Number(pass.spins_remaining) + delta }, { id: pass.id });
      this.probe("grants", "update", { spins: total }, { id: grant.id });
      // Probe hooks model separately committed writes before transaction locks.
      if (pass && Number(pass.spins_remaining) + delta < 0) return finish({ status: "invalid", error: "insufficient_spins" });
      if (pass && delta) { pass.spins_remaining = Number(pass.spins_remaining) + delta; pass.spins_granted_total = Math.max(0, Number(pass.spins_granted_total) + delta); this.syncAggregate(String(pass.fan_id)); }
      if (Object.hasOwn(patch, "spins")) { grant.spins = total; grant.bonus_spins = Math.min(Number(grant.bonus_spins), total); }
      if (Object.hasOwn(patch, "amountCents")) grant.amount_cents = patch.amountCents;
      if (Object.hasOwn(patch, "campaignId")) grant.campaign_id = patch.campaignId;
      return finish(current(false));
    }

    const request = String(args.p_request);
    const rawIntent = args.p_pack ? { ...args, p_spins: null, p_bonus: null, p_amount: null } : args;
    const intent = JSON.stringify([name, rawIntent]);
    const previous = this.economicRequests.get(request);
    if (previous) return previous.intent === intent ? { ...previous.receipt, replayed: true, balance: this.rows("fan_passes").find(p => p.id === previous.receipt.passId)?.spins_remaining ?? previous.receipt.balance } : { status: "conflict" };
    if (name === "create_pass_grant") {
      const campaign = args.p_campaign == null ? null : this.rows("campaigns").find(c => c.id === args.p_campaign && c.creator_id === creator);
      if (args.p_campaign != null && !campaign) return { status: "invalid", error: "campaign_not_found" };
      let wheel = args.p_wheel == null ? null : this.rows("wheels").find(w => w.id === args.p_wheel && w.creator_id === creator && !w.archived_at);
      if (args.p_wheel == null) wheel = this.rows("wheels").find(w => w.id === campaign?.pinned_wheel_id && w.creator_id === creator && !w.archived_at)
        ?? this.rows("wheels").find(w => w.creator_id === creator && w.is_active && !w.archived_at)
        ?? this.rows("wheels").filter(w => w.creator_id === creator && !w.archived_at).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0];
      if (!wheel) return { status: "invalid", error: "no_wheel" };
      args = { ...args, p_wheel: wheel.id };
    }
    if (args.p_pack) {
      const pack = this.rows("campaign_packs").find(p => p.id === args.p_pack && p.creator_id === creator);
      if (!pack) return { status: "pack_not_found" };
      if (pack.pack_kind !== "spins") return { status: "invalid_pack" };
      args = { ...args, p_spins: (Number(pack.spins) + Number(pack.bonus_spins)) * Number(args.p_pack_units ?? 1), p_bonus: Number(pack.bonus_spins) * Number(args.p_pack_units ?? 1), p_amount: Number(pack.amount_cents) * Number(args.p_pack_units ?? 1) };
    }
    if (Number(args.p_spins) > 1_000_000 || Number(args.p_amount) > 100_000_000) return { status: "invalid", error: "invalid_pack" };
    let fan = this.rows("fans").find(f => f.id === args.p_fan && f.creator_id === creator);
    let pass: Row | undefined;
    const fresh = name === "create_pass_grant" && args.p_fan == null;
    if (fresh) fan = this.withDefaults("fans", { creator_id: creator, display_name: args.p_name });
    if (!fan || !this.eligible(fan)) return { status: "unavailable", error: fan?.blocked_at ? "blocked" : fan?.break_until ? "on_break" : "fan_not_found" };
    if (name === "create_pass_grant") {
      pass = this.rows("fan_passes").find(p => p.fan_id === fan!.id && p.wheel_id === args.p_wheel && p.is_active && !p.self_excluded_at);
    } else pass = this.rows("fan_passes").find(p => p.id === args.p_pass && p.fan_id === fan!.id && p.creator_id === creator && p.is_active && !p.self_excluded_at);
    const newPass = name === "create_pass_grant" && !pass;
    if (newPass) pass = this.withDefaults("fan_passes", { creator_id: creator, fan_id: fan.id, wheel_id: args.p_wheel, token: `token-${request}`, campaign_id: args.p_campaign });
    if (!pass) return { status: "unavailable" };
    if (fresh) this.probe("fans", "insert", fan);
    if (newPass) this.probe("fan_passes", "insert", pass);
    this.probe("fan_passes", "update", { spins_remaining: Number(pass.spins_remaining) + Number(args.p_spins) }, { id: pass.id });
    this.probe("grants", "insert", { id: request, spins: args.p_spins });
    if (fresh) this.rows("fans").push(fan);
    if (newPass) this.rows("fan_passes").push(pass);
    pass.spins_remaining = Number(pass.spins_remaining) + Number(args.p_spins);
    pass.spins_granted_total = Number(pass.spins_granted_total) + Number(args.p_spins);
    this.seed("grants", { id: request, creator_id: creator, fan_id: fan.id, fan_pass_id: pass.id, spins: args.p_spins, bonus_spins: args.p_bonus, amount_cents: args.p_amount, campaign_id: args.p_campaign });
    if (fresh && args.p_referral_code) {
      const referrer = this.rows("fans").find(f => f.creator_id === creator && f.referral_code === args.p_referral_code && f.id !== fan!.id);
      if (referrer) { fan.referred_by_fan_id = referrer.id; this.seed("referrals", { creator_id: creator, referrer_fan_id: referrer.id, referred_fan_id: fan.id, credited_at: null, bonus_spins: 3 }); }
    }
    this.syncAggregate(String(fan.id));
    const receipt = { status: "granted", token: pass.token, fanId: fan.id, passId: pass.id, grantId: request, balance: pass.spins_remaining, replayed: false };
    this.economicRequests.set(request, { intent, receipt });
    return receipt;
  }

  private withDefaults(table: string, row: Row): Row {
    this.seq++;
    return {
      id: `${table}-${this.seq}`,
      created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, this.seq)).toISOString(),
      ...(TABLE_DEFAULTS[table] ?? {}),
      ...row,
    };
  }

  /** trg_sync_fan_spin_aggregate: fans.<col> = SUM(active passes.<col>). */
  private syncAggregate(fanId: string | undefined) {
    if (!fanId) return;
    const fan = this.rows("fans").find((f) => f.id === fanId);
    if (!fan) return;
    fan.spins_remaining = this.sumPasses(fanId, "spins_remaining");
    fan.spins_granted_total = this.sumPasses(fanId, "spins_granted_total");
  }

  private checkConstraints(): DbError | null {
    for (const f of this.rows("fans")) {
      if ((f.spins_remaining as number) < 0) {
        return { message: 'violates check constraint "fans_spins_remaining_check"', code: "23514" };
      }
    }
    return null;
  }

  /** Run one statement atomically: on a constraint failure nothing changes. */
  execute(
    table: string,
    op: Op,
    filters: Filter[],
    payload: Row | Row[] | null
  ): { rows: Row[]; error: DbError | null } {
    const stmt: Statement = {
      n: this.statements.length + 1,
      table,
      op,
      filters: filters.map(({ col, operator, value }) => ({ col, operator, value })),
      payload,
    };
    this.statements.push(stmt);
    const injected = this.beforeStatement?.(stmt);
    if (injected) return { rows: [], error: injected };

    if (this.enforceAtomicEconomy && table === "fans" && (op === "insert" || op === "update")) {
      const entries = Array.isArray(payload) ? payload : [payload ?? {}];
      if (entries.some(row => op === "insert" ? Number(row.spins_remaining ?? 0) !== 0 || Number(row.spins_granted_total ?? 0) !== 0 || Number(row.pity_counter ?? 0) !== 0 : ["spins_remaining", "spins_granted_total", "pity_counter"].some(key => key in row))) return { rows: [], error: { message: "use atomic economic RPC", code: "42501" } };
    }
    if (this.enforceAtomicEconomy && table === "fan_passes" && (op === "insert" || op === "update")) {
      const entries = Array.isArray(payload) ? payload : [payload ?? {}];
      if (entries.some(row => op === "update" ? ["spins_remaining", "spins_granted_total", "next_server_seed", "next_server_seed_hash", "next_spin_nonce"].some(key => key in row) : Number(row.spins_remaining ?? 0) !== 0 || Number(row.spins_granted_total ?? 0) !== 0)) return { rows: [], error: { message: "use atomic grant RPC", code: "42501" } };
    }
    const snapshot = Object.fromEntries(
      Object.entries(this.tables).map(([k, v]) => [k, v.map((r) => ({ ...r }))])
    );
    const touchedFans = new Set<string>();
    let affected: Row[] = [];

    if (op === "insert") {
      const list = Array.isArray(payload) ? payload : [payload ?? {}];
      affected = list.map((r) => this.withDefaults(table, r));
      this.rows(table).push(...affected);
    } else {
      affected = this.rows(table).filter((r) => filters.every((f) => f.test(r)));
      if (op === "update") {
        for (const r of affected) {
          if (table === "fan_passes") touchedFans.add(r.fan_id as string);
          Object.assign(r, payload ?? {});
        }
      } else if (op === "delete") {
        const ids = new Set(affected.map((r) => r.id));
        this.tables[table] = this.rows(table).filter((r) => !ids.has(r.id));
      }
    }

    if (table === "fan_passes") {
      for (const r of affected) touchedFans.add(r.fan_id as string);
      for (const fanId of touchedFans) this.syncAggregate(fanId);
    }

    const error = this.checkConstraints();
    if (error) {
      for (const k of Object.keys(snapshot)) this.tables[k] = snapshot[k];
      return { rows: [], error };
    }
    return { rows: affected.map((r) => ({ ...r })), error: null };
  }
}

class Query implements PromiseLike<Result> {
  private op: Op = "select";
  private payload: Row | Row[] | null = null;
  private filters: Filter[] = [];
  // supabase-js appends each .order() call as a further sort key.
  private orderBy: Array<{ col: string; ascending: boolean }> = [];
  private limitN: number | null = null;
  private mode: "many" | "single" | "maybeSingle" = "many";
  private returning = false;
  private countOnly = false;
  private countRequested = false;

  constructor(private db: FakeSupabase, private table: string) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (this.op !== "select") this.returning = true;
    if (opts?.head && opts.count) this.countOnly = true;
    if (opts?.count === "exact") this.countRequested = true;
    return this;
  }
  insert(rows: Row | Row[]) {
    this.op = "insert";
    this.payload = rows;
    return this;
  }
  update(patch: Row) {
    this.op = "update";
    this.payload = patch;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push({ col, operator: "eq", value: val, test: (r) => r[col] === val });
    return this;
  }
  gt(col: string, val: string) {
    this.filters.push({ col, operator: "gt", value: val, test: row => String(row[col]) > val }); return this;
  }
  gte(col: string, val: string) {
    this.filters.push({ col, operator: "gte", value: val, test: row => String(row[col]) >= val }); return this;
  }
  lte(col: string, val: string) {
    this.filters.push({ col, operator: "lte", value: val, test: row => String(row[col]) <= val }); return this;
  }
  neq(col: string, val: unknown) {
    this.filters.push({ col, operator: "neq", value: val, test: (r) => r[col] !== val });
    return this;
  }
  is(col: string, val: null | boolean) {
    this.filters.push({ col, operator: "is", value: val, test: (r) => (r[col] ?? null) === val });
    return this;
  }
  not(col: string, operator: string, val: unknown) {
    if (operator !== "is") throw new Error(`fakeSupabase: not(${operator}) unsupported`);
    this.filters.push({ col, operator: "not.is", value: val, test: (r) => (r[col] ?? null) !== val });
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orderBy.push({ col, ascending: opts?.ascending ?? true });
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }
  single() {
    this.mode = "single";
    return this;
  }
  maybeSingle() {
    this.mode = "maybeSingle";
    return this;
  }

  private run(): Result {
    if (this.op !== "select" && this.limitN != null) {
      throw new Error(`fakeSupabase: limit() on ${this.op} is not modelled`);
    }
    const { rows, error } = this.db.execute(this.table, this.op, this.filters, this.payload);
    if (error) return { data: null, error, count: null };
    const total = rows.length;
    const resultCount = this.countRequested ? total : null;
    let out = rows;
    if (this.orderBy.length > 0) {
      out = out.slice().sort((a, b) => {
        for (const { col, ascending } of this.orderBy) {
          const x = String(a[col] ?? ""), y = String(b[col] ?? "");
          if (x !== y) return (x < y ? -1 : 1) * (ascending ? 1 : -1);
        }
        return 0;
      });
    }
    if (this.limitN != null) out = out.slice(0, this.limitN);
    if (this.countOnly) return { data: null, error: null, count: total };
    if (this.op !== "select" && !this.returning) return { data: null, error: null, count: null };
    if (this.mode === "many") return { data: out, error: null, count: resultCount };
    if (out.length > 1) {
      return { data: null, error: { message: "multiple rows returned", code: "PGRST116" }, count: null };
    }
    if (out.length === 0 && this.mode === "single") {
      return { data: null, error: { message: "no rows returned", code: "PGRST116" }, count: null };
    }
    return { data: out[0] ?? null, error: null, count: resultCount };
  }

  then<R1 = Result, R2 = never>(
    onfulfilled?: ((value: Result) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null
  ): PromiseLike<R1 | R2> {
    return Promise.resolve().then(() => this.run()).then(onfulfilled, onrejected);
  }
}
