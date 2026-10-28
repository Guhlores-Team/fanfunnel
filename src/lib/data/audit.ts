// Data layer — the admin activity log (admin_audit_log, migration 0054).
//
// Writes go ONLY through the server with the service role (no insert grant for
// anon/authenticated, entries are append-only). Reads are admin-only: the
// session client + RLS (is_admin(), which needs aal2) AND the shared
// isActiveAdmin() check. Entries hold ids and small facts, never emails, names,
// passwords or tokens.
import { isSupabaseConfigured, createServiceClient, createClient } from "@/lib/supabase/server";
import { isActiveAdmin } from "@/lib/auth/adminCheck";
import { mockListAudit, mockRecordAudit } from "./mock";

export type AuditAction =
  | "account.create"
  | "account.approve"
  | "account.reject"
  | "account.delete"
  | "account.role_change"
  | "account.suspend"
  | "account.reactivate"
  | "account.features_change"
  | "account.mfa_reset"
  | "account.self_close"
  | "admin.bootstrap"
  | "error.resolve"
  | "error.reopen"
  | "mfa.factor_removed"
  | "retention.cleanup";

export interface AuditInput {
  actorId: string | null;
  action: AuditAction;
  targetType?: "profile" | "factor" | "error" | null;
  targetId?: string | null;
  /** Small, PII-free facts (role names, feature keys, counts, booleans). */
  details?: Record<string, string | number | boolean | null | Record<string, boolean>>;
}

export interface AuditEntry {
  id: string;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
  /** Resolved at read time for the admin view; never stored in the log. */
  actorLabel: string | null;
  targetLabel: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PII_KEY = /email|name|password|token|phone|secret|address|^ip$|^ip_|ipAddr/i;

/** Drop anything that looks like PII and anything that isn't a plain value. */
export function sanitizeAuditDetails(details: AuditInput["details"]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details ?? {})) {
    if (PII_KEY.test(k) || !/^[a-z][a-zA-Z0-9_]{0,40}$/.test(k)) continue;
    if (v === null || typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (typeof v === "string") {
      if (!v.includes("@") && v.length <= 64) out[k] = v;
    } else if (typeof v === "object") {
      const flags: Record<string, boolean> = {};
      for (const [fk, fv] of Object.entries(v)) {
        if (typeof fv === "boolean" && /^[a-z][a-zA-Z0-9_]{0,40}$/.test(fk)) flags[fk] = fv;
      }
      out[k] = flags;
    }
  }
  return out;
}

/**
 * Record one privileged action. Called AFTER the action succeeded. A failed
 * write is logged (never thrown): the action already happened and must not be
 * reported as failed to the caller.
 */
export async function recordAudit(entry: AuditInput): Promise<void> {
  const row = {
    actor_id: entry.actorId && UUID.test(entry.actorId) ? entry.actorId : null,
    action: entry.action,
    target_type: entry.targetType ?? null,
    target_id: entry.targetId && UUID.test(entry.targetId) ? entry.targetId : null,
    details: sanitizeAuditDetails(entry.details),
  };
  if (!isSupabaseConfigured()) {
    mockRecordAudit(row);
    return;
  }
  try {
    const { error } = await createServiceClient().from("admin_audit_log").insert(row);
    if (error) console.error("recordAudit: insert failed", { action: entry.action, error: error.message });
  } catch (e) {
    console.error("recordAudit: insert threw", { action: entry.action, error: String(e) });
  }
}

/** The newest entries for the admin Activity view (admins on aal2 only). */
export async function listAuditLog(limit = 200): Promise<AuditEntry[] | null> {
  const n = Math.min(Math.max(Math.trunc(limit) || 1, 1), 500);
  if (!isSupabaseConfigured()) return mockListAudit(n);

  const sb = await createClient();
  if (!(await isActiveAdmin(sb))) return null;
  const { data, error } = await sb
    .from("admin_audit_log")
    .select("id, actor_id, action, target_type, target_id, details, created_at")
    .order("created_at", { ascending: false })
    .limit(n);
  if (error) return null;
  const rows = (data ?? []) as {
    id: string;
    actor_id: string | null;
    action: string;
    target_type: string | null;
    target_id: string | null;
    details: Record<string, unknown> | null;
    created_at: string;
  }[];

  // Admins can already see every account's email in the console, so the view
  // labels ids with the CURRENT email; a deleted account stays an id.
  const ids = [
    ...new Set(rows.flatMap((r) => [r.actor_id, r.target_type === "profile" ? r.target_id : null]).filter(Boolean)),
  ] as string[];
  const labels = new Map<string, string>();
  if (ids.length > 0) {
    const { data: profiles } = await sb.from("profiles").select("id, email").in("id", ids);
    for (const p of (profiles ?? []) as { id: string; email: string | null }[]) {
      if (p.email) labels.set(p.id, p.email);
    }
  }
  return rows.map((r) => ({
    id: r.id,
    actorId: r.actor_id,
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    details: r.details ?? {},
    createdAt: r.created_at,
    actorLabel: r.actor_id ? labels.get(r.actor_id) ?? null : null,
    targetLabel: r.target_id && r.target_type === "profile" ? labels.get(r.target_id) ?? null : null,
  }));
}
