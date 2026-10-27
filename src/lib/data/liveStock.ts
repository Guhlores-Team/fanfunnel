// RM-2: the live stock a spin response carries back to the fan page, so a
// "3 left" drops to "2 left" without a reload. Read once, after the spin is
// recorded, and projected through the same fan-safe rule as the page
// (publicView.toPublicStockMap): with "Show stock to fans" off, no count leaves
// the server. Display only: the oversell guard stays takeStockUnit's
// compare-and-swap in spins.ts.
import type { PublicStock, WheelConfig } from "@/lib/games/wheel/types";
import { hasLimitedPrize, showsStock, toPublicStockMap } from "@/lib/games/wheel/publicView";
import type { AnyClient } from "./shared";

/**
 * The wheel's limited prizes as the fan may see them after this spin, or
 * undefined when the wheel has no limited prize (nothing can change) or the
 * read fails. Never throws: a missing count must not fail a recorded win.
 */
export async function readLiveStock(
  sb: AnyClient,
  wheelId: string,
  config: Pick<WheelConfig, "prizes" | "showStock">,
): Promise<Record<string, PublicStock> | undefined> {
  if (!hasLimitedPrize(config.prizes)) return undefined;
  try {
    const { data, error } = await sb
      .from("prizes")
      .select("id, stock")
      .eq("wheel_id", wheelId)
      .not("stock", "is", null);
    if (error || !Array.isArray(data)) return undefined;
    return toPublicStockMap(data as { id: string; stock: number | null }[], showsStock(config));
  } catch {
    return undefined;
  }
}
