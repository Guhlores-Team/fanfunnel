// Admin activity log: action code → readable sentence parts. Pure, so the
// Activity view and its unit test share it.

const ACTION_LABELS: Record<string, string> = {
  "account.create": "created an account",
  "account.approve": "approved an access request",
  "account.reject": "rejected an access request",
  "account.delete": "deleted an account",
  "account.role_change": "changed a role",
  "account.suspend": "suspended an account",
  "account.reactivate": "reactivated an account",
  "account.features_change": "changed features",
  "account.mfa_reset": "reset two-factor",
  "account.media_remove": "removed creator photos",
  "account.storage_retry": "retried account cleanup",
  "account.self_close": "closed their own account",
  "admin.bootstrap": "claimed the first admin",
  "admin.lookup": "looked up a win",
  "error.resolve": "resolved an error report",
  "error.reopen": "reopened an error report",
  "report.resolve": "resolved a safety report",
  "report.dismiss": "dismissed a safety report",
  "report.reopen": "reopened a safety report",
  "mfa.factor_removed": "removed a two-factor app",
  "system.canary.initialize": "initialized verified reward key protection",
  "retention.cleanup": "ran the retention cleanup",
  "legal.notice": "set or withdrew the Terms change notice",
};

export function auditActionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

/** OPS-04: the Activity filter: letters, digits, spaces and . _ - only. */
export const AUDIT_FILTER = /^[A-Za-z0-9 ._-]{1,40}$/;
/** Known action codes whose code or readable label contains `text` (case-insensitive). */
export function auditActionsMatching(text: string): string[] {
  const t = text.trim().toLowerCase();
  if (!t) return [];
  return Object.entries(ACTION_LABELS).filter(([code, label]) => code.includes(t) || label.toLowerCase().includes(t)).map(([code]) => code);
}
/** Whether one entry's action passes the filter (code or label contains it). */
export function auditActionMatches(action: string, text: string): boolean {
  const t = text.trim().toLowerCase();
  return !t || action.toLowerCase().includes(t) || auditActionLabel(action).toLowerCase().includes(t);
}

/** "abcd…1234" for an id with no current account behind it. */
export function shortId(id: string | null | undefined): string {
  if (!id) return "";
  return id.length > 12 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id;
}

/** One line of extra facts ("role: admin · fanLinks: 3"), PII-free by construction. */
export function auditDetailsSummary(details: Record<string, unknown> | null | undefined): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(details ?? {})) {
    if (v === null || v === undefined) continue;
    if (typeof v === "object") {
      const flags = Object.entries(v as Record<string, unknown>)
        .map(([fk, fv]) => `${fk} ${fv ? "on" : "off"}`)
        .join(", ");
      if (flags) parts.push(`${k}: ${flags}`);
    } else {
      parts.push(`${k}: ${String(v)}`);
    }
  }
  return parts.join(" · ");
}
