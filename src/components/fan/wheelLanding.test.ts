import assert from "node:assert/strict";
import type { PublicPrize } from "@/lib/games/wheel/types";
import { landingIndex, poolForResult, responsePrizes, withArticle } from "./wheelLanding";

const prize = (id: string, label = id): PublicPrize => ({ id, label, rarity: "common", weight: 1 });
const old = [prize("p1"), prize("p2"), prize("p3")];
const reordered = [prize("p3"), prize("p1"), prize("p2")];

assert.equal(landingIndex(old, { index: 0, prizeId: "p2" }), 1, "the prize id wins over the index");
assert.equal(landingIndex(old, { index: 2 }), 2, "without an id the index is used");
assert.equal(landingIndex(old, { index: 2, prizeId: "gone" }), 2, "an unknown id falls back to the index");
assert.equal(landingIndex(old, { index: 9 }), -1, "an index outside the list lands nowhere");
assert.equal(landingIndex(old, null), -1);

const hit = { prize: prize("p2"), prizeIndex: 2, prizes: reordered };
assert.equal(poolForResult(old, hit), reordered, "a reordered wheel is drawn from the server's list");
assert.equal(poolForResult(reordered, hit), null, "an unchanged wheel keeps the page's list");
assert.equal(poolForResult(old, { prize: prize("p2"), prizeIndex: 2 }), null, "no server list: land by id in the page's list");
assert.equal(responsePrizes({ prize: prize("p2"), prizeIndex: 0, prizes: reordered }), null, "a list that disagrees with the index is not drawn");
assert.equal(responsePrizes({ prize: prize("p2"), prizeIndex: 0, prizes: [] }), null);
assert.equal(responsePrizes({ prize: prize("p2"), prizeIndex: 0, prizes: [{ id: 7 } as unknown as PublicPrize] }), null, "malformed rows are refused");

assert.equal(withArticle("Uncommon"), "an Uncommon");
assert.equal(withArticle("Epic"), "an Epic");
assert.equal(withArticle("Rare"), "a Rare");
assert.equal(withArticle("Legendary"), "a Legendary");
console.log("wheelLanding: landing/pool/article checks passed");
