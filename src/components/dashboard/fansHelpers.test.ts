import assert from "node:assert/strict";
import { copyLinkToken, fanRowMeta, threadFanIds } from "./fansHelpers";

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

// Regression: the Fans tab "Copy link" (and the drawer's Copy link / Copy DM)
// used the fan's NEWEST link even when that link was paused by the fan or
// deactivated, and still offered a link for a blocked fan. It must hand out the
// same link win-back does: the newest ACTIVE, non-paused link, and none at all
// for a blocked or self-excluded fan.
{
  const fan = (over: Partial<Parameters<typeof copyLinkToken>[0]> = {}) => ({
    primaryToken: "newest",
    links: [{ token: "newest" }, { token: "older" }],
    activeToken: "older",
    blocked: false,
    selfExcluded: false,
    ...over,
  });
  assert.equal(copyLinkToken(fan()), "older", "a deactivated newest link is skipped for the newest active one");
  assert.equal(copyLinkToken(fan({ activeToken: "newest" })), "newest", "an active newest link is used");
  assert.equal(copyLinkToken(fan({ activeToken: null })), null, "no active link → nothing to copy");
  assert.equal(copyLinkToken(fan({ selfExcluded: true })), null, "a fan who paused a link gets no link");
  assert.equal(copyLinkToken(fan({ blocked: true, activeToken: "newest" })), null, "a blocked fan gets no link");
  assert.equal(copyLinkToken(fan({ primaryToken: null, links: [], activeToken: null })), null, "no links at all → null");
}

console.log("fansHelpers.test: all checks passed");
