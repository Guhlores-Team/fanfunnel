import assert from "node:assert";
import type { CreatorOverview, RedemptionItem } from "@/lib/data/types";
import { owedSentence, owedSummary } from "./owedSummary";

const red = (id: string, fanId: string, status: RedemptionItem["status"]): RedemptionItem => ({ id, fanId, fanName: fanId, prizeLabel: "P", rarity: "common", status, at: "2026-01-01T00:00:00Z" });
const overview = (pending: number, redemptions: RedemptionItem[]) => ({ metrics: { pending } as CreatorOverview["metrics"], redemptions });
const fan = (fanId: string, spinsRemaining: number, totalSpent: number) => ({ fanId, spinsRemaining, totalSpent });

const s = owedSummary(overview(3, [red("1", "a", "pending"), red("2", "a", "in_progress"), red("3", "b", "pending"), red("4", "c", "fulfilled"), red("5", "d", "cancelled")]),
  [fan("a", 4, 500), fan("b", 2, 0), fan("e", 6, 1200), fan("f", 0, 900)]);
assert.deepEqual(s, { fans: 2, fansAtLeast: false, prizes: 3, paidSpins: 10, payingFans: 2, unplayedSpins: 12, activeLinks: null }, "open prizes per fan; paid balances only");
assert.equal(owedSentence(s), "2 fans are owed 3 prizes and 2 fans with recorded tips hold 10 unplayed spins.");

const floor = owedSummary(overview(250, [red("1", "a", "pending")]), []);
assert.equal(floor.fansAtLeast, true, "outside the window it is a floor");
assert.equal(owedSentence(floor), "At least 1 fan is owed 250 prizes.");

assert.equal(owedSentence(owedSummary(overview(0, []), [fan("a", 1, 100)])), "1 fan with recorded tips holds 1 unplayed spin.");
assert.equal(owedSentence(owedSummary(overview(0, [red("1", "a", "fulfilled")]), [fan("a", 3, 0)])), "", "nothing owed: no sentence");
console.log("owedSummary: all checks passed");
