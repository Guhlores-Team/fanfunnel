import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  assert.equal(copyLinkToken(fan({ breakUntil: new Date(Date.now() + 86_400_000).toISOString() })), null, "a fan on a break (RM-6) gets no link");
  assert.equal(copyLinkToken(fan({ breakUntil: null })), "older", "breakUntil null = not on a break");
}

// Regression, wiring half: the bug lived in the components, which built the
// link inline as `primaryToken ?? links[0]`. Each surface that hands a fan's
// link out (the Fans row's Copy link; the drawer's Copy link, Copy DM and QR)
// must take it from copyLinkToken, or the helper above is tested but unused.
{
  const read = (f: string) => readFileSync(join(import.meta.dirname, f), "utf8");
  const panel = read("FansPanel.tsx");
  const rowCopy = /async function copyLink\(acc: FanAccountSummary\) \{([\s\S]*?)\n  \}/.exec(panel)?.[1] ?? "";
  assert.ok(rowCopy, "FansPanel still has its row copyLink(acc)");
  assert.match(rowCopy, /const token = copyLinkToken\(acc\);/, "the Fans row copies copyLinkToken(acc)");
  assert.doesNotMatch(rowCopy, /primaryToken|links\[0\]/, "the Fans row never falls back to the newest link of any state");

  const drawer = read("FanDetailDrawer.tsx");
  assert.match(drawer, /const shareToken = linkFan \? copyLinkToken\(linkFan\) : null;/, "the drawer picks its link with copyLinkToken");
  assert.match(drawer, /const primaryUrl = shareToken \? `\$\{origin\}\/spin\/\$\{shareToken\}` : null;/, "the drawer's shared URL is built from that pick");
  assert.doesNotMatch(drawer, /primaryUrl = primaryToken|\/spin\/\$\{primaryToken\}/, "the drawer never shares the newest-of-any-state token");
  for (const use of ["copyToClipboard(primaryUrl)", "link: primaryUrl", "<QrButton url={primaryUrl}"]) {
    assert.ok(drawer.includes(use), `the drawer's ${use.split("(")[0].split(" ")[0]} uses the active-link URL`);
  }
}

console.log("fansHelpers.test: all checks passed");
