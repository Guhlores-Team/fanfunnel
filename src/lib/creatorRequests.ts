/** Public creator-operation outcomes contain identity and state only. Never
 * trust an HTTP status or an absent row as proof that an old write cannot land. */
export const CREATOR_REQUEST_KINDS = ["pass", "grant", "focus", "import", "edit"] as const;
export type CreatorRequestKind = typeof CREATOR_REQUEST_KINDS[number];
export const CREATOR_REQUEST_STATUSES = ["committed", "cancelled", "rejected", "gone", "pending", "absent", "conflict", "unavailable"] as const;
export type CreatorRequestStatus = typeof CREATOR_REQUEST_STATUSES[number];
export interface CreatorRequestResult { requestId: string; kind: CreatorRequestKind; status: CreatorRequestStatus; authorized?: boolean }
export function isCreatorRequestKind(value: unknown): value is CreatorRequestKind { return typeof value === "string" && CREATOR_REQUEST_KINDS.some(kind => kind === value); }
export function creatorRequestResolved(value: CreatorRequestStatus): boolean { return value === "committed" || value === "cancelled" || value === "rejected" || value === "gone"; }
export function readCreatorRequestResult(value: unknown, requestId: string, kind: CreatorRequestKind): CreatorRequestResult | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.requestId !== requestId || row.kind !== kind || !CREATOR_REQUEST_STATUSES.some(status => status === row.status)) return null;
  return { requestId, kind, status: row.status as CreatorRequestStatus, ...(typeof row.authorized === "boolean" ? { authorized: row.authorized } : {}) };
}
