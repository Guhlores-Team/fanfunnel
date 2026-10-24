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
  wheels: { is_active: false, archived_at: null },
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
        const handler = this.rpcHandlers[name];
        if (!handler) throw new Error(`fakeSupabase: rpc ${name} is not modelled`);
        return { data: handler(args) ?? null, error: null };
      },
    };
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
  private orderBy: { col: string; ascending: boolean } | null = null;
  private limitN: number | null = null;
  private mode: "many" | "single" | "maybeSingle" = "many";
  private returning = false;
  private countOnly = false;

  constructor(private db: FakeSupabase, private table: string) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (this.op !== "select") this.returning = true;
    if (opts?.head && opts.count) this.countOnly = true;
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
    this.orderBy = { col, ascending: opts?.ascending ?? true };
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
    let out = rows;
    if (this.orderBy) {
      const { col, ascending } = this.orderBy;
      out = out.slice().sort((a, b) => {
        const x = String(a[col] ?? ""), y = String(b[col] ?? "");
        return (x < y ? -1 : x > y ? 1 : 0) * (ascending ? 1 : -1);
      });
    }
    if (this.limitN != null) out = out.slice(0, this.limitN);
    if (this.countOnly) return { data: null, error: null, count: out.length };
    if (this.op !== "select" && !this.returning) return { data: null, error: null, count: null };
    if (this.mode === "many") return { data: out, error: null, count: null };
    if (out.length > 1) {
      return { data: null, error: { message: "multiple rows returned", code: "PGRST116" }, count: null };
    }
    if (out.length === 0 && this.mode === "single") {
      return { data: null, error: { message: "no rows returned", code: "PGRST116" }, count: null };
    }
    return { data: out[0] ?? null, error: null, count: null };
  }

  then<R1 = Result, R2 = never>(
    onfulfilled?: ((value: Result) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null
  ): PromiseLike<R1 | R2> {
    return Promise.resolve().then(() => this.run()).then(onfulfilled, onrejected);
  }
}
