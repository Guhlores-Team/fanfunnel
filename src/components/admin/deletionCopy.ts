// A18: words for the Admin "Stuck account deletions" card. Pure, so the copy
// and the parsing of the route's answer are unit-tested without a browser.

export interface StuckDeletionView {
  id: string;
  state: "pending" | "auth_deleting" | "auth_deleted" | "complete" | "paused";
  lastError: string | null;
  attempts: number;
  startedAt: string;
  updatedAt: string;
  nextRetryAt: string | null;
}

const STATES = new Set(["pending", "auth_deleting", "auth_deleted", "complete", "paused"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));

/** The route's answer, or null when it is not one (never trust a shape blindly). */
export function parseStuckDeletions(body: unknown): StuckDeletionView[] | null {
  const list = (body as { deletions?: unknown } | null)?.deletions;
  if (!Array.isArray(list)) return null;
  const out: StuckDeletionView[] = [];
  for (const x of list as Record<string, unknown>[]) {
    if (!x || typeof x.id !== "string" || !UUID.test(x.id) || !STATES.has(String(x.state))) return null;
    if (!iso(x.startedAt) || !iso(x.updatedAt) || typeof x.attempts !== "number") return null;
    out.push({
      id: x.id,
      state: x.state as StuckDeletionView["state"],
      lastError: typeof x.lastError === "string" ? x.lastError : null,
      attempts: x.attempts,
      startedAt: x.startedAt,
      updatedAt: x.updatedAt,
      nextRetryAt: iso(x.nextRetryAt) ? x.nextRetryAt : null,
    });
  }
  return out;
}

export function deletionStateLabel(d: Pick<StuckDeletionView, "state">): string {
  switch (d.state) {
    case "paused": return "Paused";
    case "pending": return "Removing files";
    case "auth_deleting": return "Deleting sign-in";
    case "auth_deleted": return "Finishing";
    default: return "Complete";
  }
}

export function deletionErrorLabel(error: string | null): string {
  switch (error) {
    case "storage_cleanup_failed": return "Stored photos could not be removed";
    case "delete_failed": return "The sign-in account could not be deleted";
    case "upload_unconfirmed": return "Waiting for an upload to settle";
    case "db_error": return "The database did not answer";
    case null: return "No error recorded";
    default: return "Unexpected error";
  }
}

/** "3 h", "2 d": how long ago, coarse on purpose. */
export function ageLabel(from: string, now: number = Date.now()): string {
  const ms = Math.max(0, now - Date.parse(from));
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h` : `${Math.floor(h / 24)} d`;
}

export function nextRetryLabel(d: Pick<StuckDeletionView, "state" | "nextRetryAt">, now: number = Date.now()): string {
  if (d.state !== "paused") return "Retried by the daily maintenance run";
  if (!d.nextRetryAt) return "Automatic retries used up: retry it here";
  return Date.parse(d.nextRetryAt) <= now ? "Automatic retry due on the next maintenance run" : `Automatic retry after ${new Date(d.nextRetryAt).toLocaleString()}`;
}

export function retryResultMessage(status: number, error: string | undefined): string {
  if (status === 200) return "Deletion completed.";
  if (status === 202) return "Retry started; cleanup is still running. Refresh in a few minutes.";
  if (error === "last_admin") return "This is the last active admin. Add or reactivate another admin first.";
  if (error === "not_found") return "This deletion no longer exists. Refresh the list.";
  if (status === 401 || status === 403) return "Sign in again with two-factor authentication to retry.";
  return "The retry did not complete. It stays listed here; try again later.";
}
