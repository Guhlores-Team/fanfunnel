// Preserve PostgreSQL's microseconds: Date.toISOString() would skip wins at
// page boundaries when several rows share the same JavaScript millisecond.
export interface RewardHistoryCursor { at: string; shareId: string }
export function rewardHistoryTimestamp(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const match = input.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:Z|\+00:00)$/);
  if (!match) return null;
  const date = new Date(input);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0,19) !== match[1]) return null;
  return `${match[1]}.${(match[2] ?? "").padEnd(6,"0")}Z`;
}
export function encodeRewardHistoryCursor(v: RewardHistoryCursor): string {
  const at = rewardHistoryTimestamp(v.at);
  if (!at) throw new Error("Invalid history timestamp");
  return btoa(JSON.stringify({ at, shareId: v.shareId }))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function decodeRewardHistoryCursor(input: unknown): RewardHistoryCursor | null {
  if (typeof input !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(input)) return null;
  try {
    const v = JSON.parse(atob(input.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
    if (Object.keys(v).sort().join() !== "at,shareId" || typeof v.at !== "string" || typeof v.shareId !== "string") return null;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(v.shareId) || rewardHistoryTimestamp(v.at) !== v.at) return null;
    const cursor = { at: v.at, shareId: v.shareId };
    return encodeRewardHistoryCursor(cursor) === input ? cursor : null;
  } catch { return null; }
}
