import "server-only";
import type { AnyClient } from "./shared";
/** Exact counts rather than display-capped history; a read failure stays unknown. */
export async function readGamePlayCounts(sb: AnyClient, creatorId: string, cutoff?: string): Promise<{ wheel: number; scratch: number; bingo: number } | null> {
  try {
    const results = await Promise.all((["wheel", "scratch", "bingo"] as const).map(kind => {
      let query = sb.from("spins").select("id", { count: "exact", head: true }).eq("creator_id", creatorId).eq("kind", "play").eq("game_kind", kind);
      if (cutoff) query = query.lte("created_at", cutoff);
      return query;
    }));
    if (results.some(result => result.error || typeof result.count !== "number")) return null;
    return { wheel: results[0].count!, scratch: results[1].count!, bingo: results[2].count! };
  } catch { return null; }
}
