// Data layer — monitored app errors (migration 0053).
//
// Writes (record + alert budget) go ONLY through the service role, from the
// server: POST /api/errors and the instrumentation hook. Reads and resolves use
// the caller's cookie-bound client, so RLS (is_admin()) is a second gate behind
// the route's requireAdminRoute(). In demo mode (no Supabase) an in-memory
// store with the same semantics stands in, so the mock and real paths match.
import { isSupabaseConfigured, createServiceClient, createClient } from "@/lib/supabase/server";
import { APP_ERRORS_MAX_ROWS, type ErrorEnvironment, type ErrorSource } from "@/lib/monitoring/config";
import type { RecordOutcome } from "@/lib/monitoring/alert";

export interface AppErrorRow {
  id: string;
  fingerprint: string;
  environment: ErrorEnvironment;
  source: ErrorSource;
  route: string | null;
  message: string;
  stack: string | null;
  userAgent: string | null;
  count: number;
  firstSeen: string;
  lastSeen: string;
  resolved: boolean;
  resolvedAt: string | null;
}

export interface RecordInput {
  fingerprint: string;
  environment: ErrorEnvironment;
  source: ErrorSource;
  message: string;
  route?: string;
  stack?: string;
  userAgent?: string;
}

export type ErrorStatusFilter = "open" | "resolved";

// ---------------------------------------------------------------------------
// In-memory store (demo mode). Pinned to globalThis like the mock data store.
// ---------------------------------------------------------------------------

interface MemRow extends AppErrorRow {
  alertPending: boolean;
}
interface MemStore {
  rows: Map<string, MemRow>;
  alerts: number[];
}
const g = globalThis as unknown as { __ffAppErrors?: MemStore };
function mem(): MemStore {
  return (g.__ffAppErrors ??= { rows: new Map(), alerts: [] });
}

/** Test hook: empty the in-memory store. */
export function resetMemoryAppErrors(): void {
  g.__ffAppErrors = { rows: new Map(), alerts: [] };
}

const HOUR = 60 * 60 * 1000;

/**
 * The throttle rule shared with claim_app_error_alert(): drop sends older than
 * an hour, then allow one more only while fewer than `limit` remain.
 */
export function throttleAllows(sentAt: number[], now: number, limit: number): { allowed: boolean; recent: number[] } {
  const recent = sentAt.filter((t) => t > now - HOUR);
  return { allowed: recent.length < Math.max(0, limit), recent };
}

function memRecord(input: RecordInput, maxRows: number): RecordOutcome {
  const store = mem();
  const key = `${input.environment}:${input.fingerprint}`;
  const now = new Date().toISOString();
  const existing = store.rows.get(key);
  if (existing) {
    const reopened = existing.resolved;
    existing.count = Math.min(existing.count, 2147483646) + 1;
    existing.lastSeen = now;
    existing.resolved = false;
    existing.resolvedAt = null;
    return { id: existing.id, isNew: false, reopened, count: existing.count, firstSeen: existing.firstSeen };
  }
  const row: MemRow = {
    id: crypto.randomUUID(),
    fingerprint: input.fingerprint,
    environment: input.environment,
    source: input.source,
    route: input.route ?? null,
    message: input.message,
    stack: input.stack ?? null,
    userAgent: input.userAgent ?? null,
    count: 1,
    firstSeen: now,
    lastSeen: now,
    resolved: false,
    resolvedAt: null,
    alertPending: false,
  };
  store.rows.set(key, row);
  // Same prune order as the RPC: resolved first, then oldest last_seen.
  const over = store.rows.size - Math.max(1, maxRows);
  if (over > 0) {
    const victims = [...store.rows.entries()]
      .filter(([, r]) => r.id !== row.id)
      .sort(([, a], [, b]) => Number(b.resolved) - Number(a.resolved) || a.lastSeen.localeCompare(b.lastSeen))
      .slice(0, over);
    for (const [k] of victims) store.rows.delete(k);
  }
  return { id: row.id, isNew: true, reopened: false, count: 1, firstSeen: now };
}

function memClaim(limit: number, errorId?: string): { send: boolean; pending: number } {
  const store = mem();
  const now = Date.now();
  const { allowed, recent } = throttleAllows(store.alerts, now, limit);
  store.alerts = recent;
  const rows = [...store.rows.values()];
  if (!allowed) {
    const row = errorId ? rows.find((r) => r.id === errorId) : undefined;
    if (row) row.alertPending = true;
    return { send: false, pending: 0 };
  }
  const pending = rows.filter((r) => r.alertPending && !r.resolved && r.id !== errorId).length;
  if (!errorId && pending === 0) return { send: false, pending: 0 };
  for (const r of rows) r.alertPending = false;
  store.alerts.push(now);
  return { send: true, pending };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function toOutcome(data: unknown): RecordOutcome | null {
  const d = data as { id?: unknown; is_new?: unknown; reopened?: unknown; count?: unknown; first_seen?: unknown } | null;
  if (!d || typeof d.id !== "string") return null;
  return {
    id: d.id,
    isNew: d.is_new === true,
    reopened: d.reopened === true,
    count: typeof d.count === "number" ? d.count : 1,
    firstSeen: typeof d.first_seen === "string" ? d.first_seen : new Date().toISOString(),
  };
}

/** Upsert one occurrence (service role). Null when the write failed. */
export async function recordAppError(
  input: RecordInput,
  maxRows: number = APP_ERRORS_MAX_ROWS,
): Promise<RecordOutcome | null> {
  if (!isSupabaseConfigured()) return memRecord(input, maxRows);
  const { data, error } = await createServiceClient().rpc("record_app_error", {
    p_fingerprint: input.fingerprint,
    p_environment: input.environment,
    p_source: input.source,
    p_message: input.message,
    p_route: input.route,
    p_stack: input.stack,
    p_user_agent: input.userAgent,
    p_max_rows: maxRows,
  });
  if (error) return null;
  return toOutcome(data);
}

/**
 * Take one slot of the global hourly alert budget (service role). With an
 * error id: send that error's alert (`pending` = throttled errors it also
 * covers), or mark it for a later digest. Without: a digest check.
 */
export async function claimAppErrorAlert(
  limit: number,
  errorId?: string,
): Promise<{ send: boolean; pending: number }> {
  if (!isSupabaseConfigured()) return memClaim(limit, errorId);
  const { data, error } = await createServiceClient().rpc("claim_app_error_alert", {
    p_limit: limit,
    p_error_id: errorId,
  });
  const d = data as { send?: unknown; pending?: unknown } | null;
  if (error || !d) return { send: false, pending: 0 };
  return { send: d.send === true, pending: typeof d.pending === "number" ? d.pending : 0 };
}

type DbRow = {
  id: string;
  fingerprint: string;
  environment: string;
  source: string;
  route: string | null;
  message: string;
  stack: string | null;
  user_agent: string | null;
  count: number;
  first_seen: string;
  last_seen: string;
  resolved: boolean;
  resolved_at: string | null;
};

function fromDb(r: DbRow): AppErrorRow {
  return {
    id: r.id,
    fingerprint: r.fingerprint,
    environment: r.environment as ErrorEnvironment,
    source: r.source as ErrorSource,
    route: r.route,
    message: r.message,
    stack: r.stack,
    userAgent: r.user_agent,
    count: r.count,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    resolved: r.resolved,
    resolvedAt: r.resolved_at,
  };
}

export const LIST_LIMIT = 200;

/** Grouped errors, newest first (admin; RLS-enforced on the real path). */
export async function listAppErrors(filter: {
  status: ErrorStatusFilter;
  environment?: ErrorEnvironment;
}): Promise<AppErrorRow[] | { error: string }> {
  const resolved = filter.status === "resolved";
  if (!isSupabaseConfigured()) {
    return [...mem().rows.values()]
      .filter((r) => r.resolved === resolved && (!filter.environment || r.environment === filter.environment))
      .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
      .slice(0, LIST_LIMIT)
      .map(({ alertPending: _alertPending, ...row }) => row);
  }
  const sb = await createClient();
  let q = sb
    .from("app_errors")
    .select("id, fingerprint, environment, source, route, message, stack, user_agent, count, first_seen, last_seen, resolved, resolved_at")
    .eq("resolved", resolved);
  if (filter.environment) q = q.eq("environment", filter.environment);
  const { data, error } = await q.order("last_seen", { ascending: false }).limit(LIST_LIMIT);
  if (error) return { error: "load_failed" };
  return ((data ?? []) as DbRow[]).map(fromDb);
}

/** Mark one error resolved (or open again). Admin; RLS + column grant enforced. */
export async function resolveAppError(id: string, resolved: boolean): Promise<{ ok: true } | { error: string }> {
  const resolvedAt = resolved ? new Date().toISOString() : null;
  if (!isSupabaseConfigured()) {
    const row = [...mem().rows.values()].find((r) => r.id === id);
    if (!row) return { error: "not_found" };
    row.resolved = resolved;
    row.resolvedAt = resolvedAt;
    return { ok: true };
  }
  const sb = await createClient();
  const { data, error } = await sb
    .from("app_errors")
    .update({ resolved, resolved_at: resolvedAt })
    .eq("id", id)
    .select("id");
  if (error) return { error: "update_failed" };
  if (!data || data.length === 0) return { error: "not_found" };
  return { ok: true };
}
