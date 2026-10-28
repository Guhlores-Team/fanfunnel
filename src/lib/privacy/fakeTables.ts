// Test-only: a tiny in-memory stand-in for the supabase-js query builder slice
// the privacy code uses (select/insert/upsert/update/delete with eq/in/is,
// order/limit/range, maybeSingle/single, count+head, and thenable results).
// Every executed statement is recorded with its table, operation and filters,
// so a test can assert WHICH rows a code path was allowed to touch. Unknown
// builder methods throw, so a test can't pass on behaviour this fake made up.

export type Row = Record<string, unknown>;
export interface Statement {
  table: string;
  op: "select" | "insert" | "upsert" | "update" | "delete";
  filters: { kind: "eq" | "in" | "is"; col: string; value: unknown }[];
  columns?: string;
  payload?: unknown;
}

type Result = { data: unknown; error: { message: string } | null; count: number | null };

export class FakeTables {
  readonly statements: Statement[] = [];
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

  run(stmt: Statement, opts: { single?: "maybe" | "one"; head?: boolean; count?: boolean; range?: [number, number] }): Result {
    this.statements.push(stmt);
    const fail = this.failWhen?.(stmt);
    if (fail) return { data: null, error: { message: fail }, count: null };
    const match = (r: Row) =>
      stmt.filters.every((f) =>
        f.kind === "eq"
          ? r[f.col] === f.value
          : f.kind === "in"
            ? (f.value as unknown[]).includes(r[f.col])
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
    let hits = rows.filter(match).map(project);
    const count = hits.length;
    if (opts.range) hits = hits.slice(opts.range[0], opts.range[1] + 1);
    if (opts.head) return { data: null, error: null, count };
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
  private opts: { single?: "maybe" | "one"; head?: boolean; count?: boolean; range?: [number, number] } = {};
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
  order() {
    return this;
  }
  limit() {
    return this;
  }
  range(from: number, to: number) {
    this.opts.range = [from, to];
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
