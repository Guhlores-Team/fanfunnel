// Test-only: a tiny in-memory stand-in for the supabase-js query builder slice
// the privacy code uses (select/insert/upsert/update/delete with eq/in/is,
// gt/gte/lt/lte, not-is-null, order/limit/range, maybeSingle/single, count+head, and thenable results).
// Every executed statement is recorded with its table, operation and filters,
// so a test can assert WHICH rows a code path was allowed to touch. Unknown
// builder methods throw, so a test can't pass on behaviour this fake made up.

export type Row = Record<string, unknown>;
export interface Statement {
  table: string;
  op: "select" | "insert" | "upsert" | "update" | "delete";
  filters: { kind: "eq" | "in" | "is" | "not_is" | "gt" | "gte" | "lt" | "lte"; col: string; value: unknown }[];
  columns?: string;
  orders?: { column: string; ascending: boolean }[];
  range?: [number, number];
  payload?: unknown;
}

type Result = { data: unknown; error: { message: string } | null; count: number | null };

export class FakeTables {
  readonly statements: Statement[] = [];
  /** Model PostgREST's configured maximum page size. */
  rowLimit = 1000;
  /** Make a statement fail (return a message) before it touches the store. */
  failWhen: ((s: Statement) => string | null) | null = null;
  /** Model ON DELETE CASCADE / SET NULL: called with the rows a delete removed. */
  onDelete: ((table: string, removed: Row[]) => void) | null = null;

  constructor(readonly tables: Record<string, Row[]>) {}

  rows(table: string): Row[] {
    return (this.tables[table] ??= []);
  }

  from(table: string) {
    return new Builder(this, table);
  }

  run(stmt: Statement, opts: { single?: "maybe" | "one"; head?: boolean; count?: boolean; range?: [number, number]; limit?: number }): Result {
    this.statements.push(stmt);
    const fail = this.failWhen?.(stmt);
    if (fail) return { data: null, error: { message: fail }, count: null };
    // Range comparisons follow SQL: a NULL/absent column never matches.
    const compare = (v: unknown, x: unknown, ok: (c: number) => boolean) =>
      v !== null && v !== undefined && ok(String(v) < String(x) ? -1 : String(v) > String(x) ? 1 : 0);
    const match = (r: Row) =>
      stmt.filters.every((f) =>
        f.kind === "eq"
          ? r[f.col] === f.value
          : f.kind === "in"
            ? (f.value as unknown[]).includes(r[f.col])
            : f.kind === "not_is"
              ? r[f.col] !== null && r[f.col] !== undefined
              : f.kind === "gt"
                ? compare(r[f.col], f.value, (c) => c > 0)
                : f.kind === "gte"
                  ? compare(r[f.col], f.value, (c) => c >= 0)
                  : f.kind === "lt"
                    ? compare(r[f.col], f.value, (c) => c < 0)
                    : f.kind === "lte"
                      ? compare(r[f.col], f.value, (c) => c <= 0)
                      : r[f.col] === f.value
      );
    const rows = this.rows(stmt.table);
    if (stmt.op === "insert" || stmt.op === "upsert") {
      const list = (Array.isArray(stmt.payload) ? stmt.payload : [stmt.payload]) as Row[];
      rows.push(...list.map((r) => ({ ...r })));
      return { data: null, error: null, count: null };
    }
    if (stmt.op === "delete") {
      const keep = rows.filter((r) => !match(r));
      const removed = rows.filter(match);
      this.tables[stmt.table] = keep;
      this.onDelete?.(stmt.table, removed);
      return { data: null, error: null, count: removed.length };
    }
    if (stmt.op === "update") {
      for (const r of rows) if (match(r)) Object.assign(r, stmt.payload as Row);
      return { data: null, error: null, count: null };
    }
    // Return only the selected columns, like PostgREST ("*" = all; embedded
    // joins such as `wheel:wheels(title)` are not modelled and come back absent).
    const cols =
      !stmt.columns || stmt.columns.includes("*")
        ? null
        : stmt.columns
            .replace(/\w+:\w+\([^)]*\)/g, "")
            .split(",")
            .map((c) => c.trim())
            .filter(Boolean);
    const project = (r: Row): Row =>
      cols ? Object.fromEntries(cols.filter((c) => c in r).map((c) => [c, r[c]])) : { ...r };
    const matched = rows.filter(match);
    if (stmt.orders?.length) matched.sort((a, b) => {
      for (const { column, ascending } of stmt.orders ?? []) {
        if (a[column] === b[column]) continue;
        const comparison = String(a[column] ?? "").localeCompare(String(b[column] ?? ""));
        return ascending ? comparison : -comparison;
      }
      return 0;
    });
    let hits = matched.map(project);
    const count = hits.length;
    if (opts.range) hits = hits.slice(opts.range[0], opts.range[1] + 1);
    if (opts.head) return { data: null, error: null, count };
    hits = hits.slice(0, Math.min(opts.limit ?? Infinity, this.rowLimit));
    if (opts.single) {
      if (hits.length > 1) return { data: null, error: { message: "multiple rows" }, count: null };
      if (opts.single === "one" && hits.length === 0) return { data: null, error: { message: "no rows" }, count: null };
      return { data: hits[0] ?? null, error: null, count: null };
    }
    return { data: hits, error: null, count: opts.count ? count : null };
  }
}

class Builder implements PromiseLike<Result> {
  private stmt: Statement;
  private opts: { single?: "maybe" | "one"; head?: boolean; count?: boolean; range?: [number, number]; limit?: number } = {};
  private done: Result | null = null;

  constructor(private db: FakeTables, table: string) {
    this.stmt = { table, op: "select", filters: [] };
  }
  select(columns?: string, o?: { count?: string; head?: boolean }) {
    if (this.stmt.op === "select") this.stmt.columns = columns;
    if (o?.count) this.opts.count = true;
    if (o?.head) this.opts.head = true;
    return this;
  }
  insert(payload: unknown) {
    this.stmt.op = "insert";
    this.stmt.payload = payload;
    return this;
  }
  upsert(payload: unknown) {
    this.stmt.op = "upsert";
    this.stmt.payload = payload;
    return this;
  }
  update(payload: unknown) {
    this.stmt.op = "update";
    this.stmt.payload = payload;
    return this;
  }
  delete() {
    this.stmt.op = "delete";
    return this;
  }
  eq(col: string, value: unknown) {
    this.stmt.filters.push({ kind: "eq", col, value });
    return this;
  }
  in(col: string, value: unknown[]) {
    this.stmt.filters.push({ kind: "in", col, value });
    return this;
  }
  is(col: string, value: unknown) {
    this.stmt.filters.push({ kind: "is", col, value });
    return this;
  }
  not(col: string, operator: string, value: unknown) {
    if (operator !== "is" || value !== null) throw new Error(`FakeTables: unsupported not(${operator})`);
    this.stmt.filters.push({ kind: "not_is", col, value });
    return this;
  }
  gt(col: string, value: unknown) {
    this.stmt.filters.push({ kind: "gt", col, value });
    return this;
  }
  gte(col: string, value: unknown) {
    this.stmt.filters.push({ kind: "gte", col, value });
    return this;
  }
  lt(col: string, value: unknown) {
    this.stmt.filters.push({ kind: "lt", col, value });
    return this;
  }
  lte(col: string, value: unknown) {
    this.stmt.filters.push({ kind: "lte", col, value });
    return this;
  }
  order(column: string, options: { ascending?: boolean } = {}) {
    (this.stmt.orders ??= []).push({ column, ascending: options.ascending !== false });
    return this;
  }
  limit(value: number) {
    this.opts.limit = value;
    return this;
  }
  range(from: number, to: number) {
    this.opts.range = [from, to];
    this.stmt.range = [from, to];
    return this;
  }
  maybeSingle() {
    this.opts.single = "maybe";
    return Promise.resolve(this.exec());
  }
  single() {
    this.opts.single = "one";
    return Promise.resolve(this.exec());
  }
  private exec(): Result {
    return (this.done ??= this.db.run(this.stmt, this.opts));
  }
  then<A = Result, B = never>(ok?: ((v: Result) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return Promise.resolve(this.exec()).then(ok, bad);
  }
}

/** The statements that read or wrote `table`. */
export function on(db: FakeTables, table: string): Statement[] {
  return db.statements.filter((s) => s.table === table);
}

/** The value of filter `col` on a statement (eq), if any. */
export function eqValue(s: Statement, col: string): unknown {
  return s.filters.find((f) => f.kind === "eq" && f.col === col)?.value;
}
