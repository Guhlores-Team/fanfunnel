import assert from "node:assert/strict";
import { fanRowMeta, threadFanIds } from "./fansHelpers";

// P33: campaign names are part of the row meta line (they were chips on main).
{
  const line = fanRowMeta({
    grantedTotal: 3,
    links: [{ token: "a" }],
    totalSpent: 1250,
    campaignNames: ["Spring promo", "VIP campaign"],
  });
  assert.equal(line, "3 granted · 1 link · $12.50 spent · Spring promo, VIP campaign");
}

// No campaigns → no trailing separator; plural links.
{
  const line = fanRowMeta({
    grantedTotal: 0,
    links: [{ token: "a" }, { token: "b" }],
    totalSpent: 0,
    campaignNames: [],
  });
  assert.equal(line, "0 granted · 2 links · $0.00 spent");
}

// Blank campaign names never render as empty segments.
{
  const line = fanRowMeta({ grantedTotal: 1, links: [], totalSpent: 0, campaignNames: [" ", "Direct"] });
  assert.equal(line, "1 granted · 0 links · $0.00 spent · Direct");
}

// P12: the drawer's "Message" knows which fans already have a thread.
{
  const ids = threadFanIds([{ fanId: "f1" }, { fanId: "f2" }, { fanId: "f1" }]);
  assert.equal(ids.size, 2);
  assert.ok(ids.has("f1") && ids.has("f2") && !ids.has("f3"));
}

console.log("fansHelpers.test: all checks passed");
