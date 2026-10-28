// Shared export limits and a final deny-list for secrets embedded in JSON
// columns or demo rows. Database reads still use explicit column allowlists.
export const EXPORT_PAGE_SIZE = 1000;
export const EXPORT_ROW_CAP = 50_000;
const SECRET_FIELD = /^(?:token|pass_?Token|nextServerSeed|next_server_seed|cipher|iv|keyVersion|key_version|fingerprint|hint|p256dh|auth|endpoint|secret|password|access_?Token|refresh_?Token|api_?Key|private_?Key|encryption_?Key|reward|reward_?Value|codes)$/i;
const FAN_PRIVATE_FIELD = /^(?:notes|tags|due_at|dueAt|cost_cents|costCents|amount_cents|amountCents|snoozed_until|snoozedUntil|template_id|templateId)$/;

export function safeExportValue(value: unknown, fan = false): unknown {
  if (Array.isArray(value)) return value.map((entry) => safeExportValue(entry, fan));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !SECRET_FIELD.test(key) && !(fan && FAN_PRIVATE_FIELD.test(key)))
    .map(([key, entry]) => [key, safeExportValue(entry, fan)]));
}

export function exportStatus(failed: string[], truncated: string[]) {
  const errors = [...new Set(failed)].sort();
  const limits = [...new Set(truncated)].sort();
  return { complete: errors.length === 0 && limits.length === 0, failed: errors, truncated: limits };
}

/** Shared download feedback: a saved partial file must not look complete. */
export function exportDownloadWarning(value: unknown): string | null {
  if (!value || typeof value !== "object") return "The download could not be checked. Try again.";
  const status = value as { complete?: unknown; failed?: unknown; truncated?: unknown };
  if (Array.isArray(status.truncated) && status.truncated.length > 0) {
    return "Downloaded a partial copy. Contact support for the remaining records.";
  }
  if (status.complete === false || (Array.isArray(status.failed) && status.failed.length > 0)) {
    return "Downloaded a partial copy because some records could not be read. Try again in a minute.";
  }
  return null;
}
