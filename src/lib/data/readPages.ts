import "server-only";
import type { AnyClient } from "./shared";

export const READ_PAGE_SIZE = 500;
export const MAX_REPORT_ROWS = 50_000;
export const MAX_REPORT_PAGES = 128;
export class CompleteReadError extends Error {
  constructor(readonly reason: "unavailable" | "limit" = "unavailable") { super("Report data is unavailable"); this.name = "CompleteReadError"; }
}
type Page<T> = { data: T[] | null; error: unknown; count?: number | null };
export type ReadQuery<T> = PromiseLike<Page<T>> & {
  select(columns: string, options: { count: "exact" }): ReadQuery<T>;
  eq(column: string, value: unknown): ReadQuery<T>;
  gt(column: string, value: string): ReadQuery<T>;
  gte(column: string, value: string): ReadQuery<T>;
  lte(column: string, value: string): ReadQuery<T>;
  is(column: string, value: null): ReadQuery<T>;
  not(column: string, operator: "is", value: null): ReadQuery<T>;
  in(column: string, values: string[]): ReadQuery<T>;
  order(column: string, options?: { ascending?: boolean }): ReadQuery<T>;
  limit(size: number): ReadQuery<T>;
};
/** A complete bounded report or an explicit failure, never a partial total.
 * Exact remaining counts also detect a server row cap below our page size.
 * Missing count metadata is handled by reading until an empty page. */
export async function visitIdPages<T extends { id: string }>(
  page: (after: string | null, limit: number) => PromiseLike<Page<T>>,
  visit: (rows: T[]) => void,
  pageSize = READ_PAGE_SIZE,
  maxRows = MAX_REPORT_ROWS,
): Promise<void> {
  let after: string | null = null, visited = 0, pages = 0;
  while (true) {
    if (pages++ >= MAX_REPORT_PAGES) throw new CompleteReadError("limit");
    const remaining = maxRows - visited;
    const requested = Math.min(pageSize, Math.max(1, remaining));
    let result: Page<T>;
    try { result = await page(after, requested); }
    catch { throw new CompleteReadError(); }
    if (result.error || !Array.isArray(result.data)) throw new CompleteReadError();
    const rows = result.data;
    if (rows.length > requested) throw new CompleteReadError();
    if (rows.length > remaining) throw new CompleteReadError("limit");
    if (typeof result.count === "number") {
      if (!Number.isSafeInteger(result.count) || result.count < rows.length) throw new CompleteReadError();
      if (visited + result.count > maxRows) throw new CompleteReadError("limit");
    }
    let previous: string | null = after;
    for (const row of rows) {
      if (typeof row.id !== "string" || !row.id || (previous !== null && row.id <= previous)) throw new CompleteReadError();
      previous = row.id;
    }
    if (!rows.length) {
      if (typeof result.count === "number" && result.count > 0) throw new CompleteReadError();
      return;
    }
    visit(rows); visited += rows.length; after = previous;
    if (typeof result.count === "number") {
      if (result.count < rows.length) throw new CompleteReadError();
      if (result.count === rows.length) return;
    }
  }
}
/** All factories keep their own tenant/date/relationship predicates. UUID IDs
 * are immutable; one fixed created_at cutoff excludes new concurrent inserts. */
export async function visitScopedRows<T extends object>(
  sb: AnyClient,
  table: string,
  columns: string,
  scope: (query: ReadQuery<T & { id: string }>) => ReadQuery<T & { id: string }>,
  cutoff: string,
  visit: (rows: (T & { id: string })[]) => void,
  pageSize = READ_PAGE_SIZE,
): Promise<void> {
  const client = sb as unknown as { from(table: string): ReadQuery<T & { id: string }> };
  await visitIdPages((after, limit) => {
    let query = scope(client.from(table).select(`id, ${columns}`, { count: "exact" })).lte("created_at", cutoff).order("id", { ascending: true }).limit(limit);
    if (after !== null) query = query.gt("id", after);
    return query;
  }, visit, pageSize);
}
export async function readScopedRows<T extends object>(
  sb: AnyClient,
  table: string,
  columns: string,
  scope: (query: ReadQuery<T & { id: string }>) => ReadQuery<T & { id: string }>,
  cutoff: string,
  pageSize = READ_PAGE_SIZE,
): Promise<(T & { id: string })[]> {
  const rows: (T & { id: string })[] = [];
  await visitScopedRows(sb, table, columns, scope, cutoff, page => { rows.push(...page); }, pageSize);
  return rows;
}
