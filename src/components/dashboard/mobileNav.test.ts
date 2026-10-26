import assert from "node:assert";
import { NAV_GROUPS, type Tab } from "./DashboardShell";
import { BAR_TABS, isMoreTab, moreBadgeCount, moreGroups } from "./mobileNav";

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const ids = (showAdmin: boolean) => moreGroups(showAdmin).flatMap((g) => g.items.map(([t]) => t));

// --- bar vs More split -----------------------------------------------------
{
  check("bar holds the design's four sections in order", BAR_TABS.join() === "today,inbox,editor,fans");

  const more = ids(false);
  check(
    "More (non-admin) holds every other section in sidebar order",
    more.join() === "prizes,campaigns,boosts,analytics,settings"
  );
  check("More (non-admin) has no Admin", !more.includes("admin"));
  check("More never repeats a bar section", more.every((t) => !BAR_TABS.includes(t)));

  const sidebar = NAV_GROUPS.flatMap((g) => g.items.map(([t]) => t));
  check(
    "bar + More cover every sidebar section exactly once",
    [...BAR_TABS, ...more].sort().join() === [...sidebar].sort().join()
  );

  const adminMore = ids(true);
  check("Admin appears only when the server gate is true", adminMore.at(-1) === "admin");
  check("Admin is listed once", adminMore.filter((t) => t === "admin").length === 1);
  const account = moreGroups(true).find((g) => g.title === "Account");
  check("Admin sits in the Account group after Settings", account?.items.map(([t]) => t).join() === "settings,admin");
  check("Admin is labelled 'Admin'", account?.items[1]?.[1] === "Admin");

  check("groups with no remaining items are dropped", moreGroups(false).every((g) => g.items.length > 0));
  check(
    "group titles keep sidebar order",
    moreGroups(false).map((g) => g.title).join() === "Run,Build,Grow,Measure,Account"
  );
  check("moreGroups does not mutate NAV_GROUPS", NAV_GROUPS[0].items.length === 3);
}

// --- isMoreTab -------------------------------------------------------------
{
  const all: Tab[] = ["today", "inbox", "prizes", "editor", "campaigns", "fans", "boosts", "analytics", "settings", "admin"];
  for (const t of all) check(`isMoreTab(${t})`, isMoreTab(t) === !BAR_TABS.includes(t));
}

// --- moreBadgeCount --------------------------------------------------------
{
  check("pending fulfilment counts toward More", moreBadgeCount({ prizes: 3, inbox: 5 }, false) === 3);
  check("Inbox unread stays on the bar, not More", moreBadgeCount({ inbox: 5 }, false) === 0);
  check("no badges → 0", moreBadgeCount({}, true) === 0);
  check("negative counts are ignored", moreBadgeCount({ prizes: -2 }, false) === 0);
  check("admin badge only counts when Admin is shown", moreBadgeCount({ admin: 2 }, false) === 0 && moreBadgeCount({ admin: 2 }, true) === 2);
}

console.log(`mobileNav: ${passed} checks passed`);
