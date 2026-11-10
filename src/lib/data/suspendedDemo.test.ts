import assert from "node:assert/strict";
import { mockCreatePass, mockGetWheel, mockListFans, mockSetDemoCreatorActive } from "./mock";
import { createWheel, saveWheel, setActiveWheel, archiveWheel } from "./wheels";
import { setMyDisplayName, setActiveWheelBrandColor } from "./account";
import { createCampaign } from "./campaigns";
import { grantSpins, setFanBlocked, updateFanLink } from "./fans";
import { patchRedemption } from "./fulfilment";
import { sendCreatorMessage } from "./inbox";
import { setMyPublicProfile } from "./publicProfile";
import { createWebhook } from "./webhooks";

// WU-01 parity: the database refuses every write of a suspended creator
// (can_act_for requires is_active). The demo answers the same `forbidden`,
// so the dashboard's refusals can be exercised without a database, and a
// reactivated creator writes again.

let passed = 0;
function check(label: string, value: unknown) {
  assert.ok(value, label);
  passed++;
}
const forbidden = (r: unknown) => !!r && typeof r === "object" && "error" in r && (r as { error: unknown }).error === "forbidden";

async function main() {
  const fan = mockCreatePass("Suspended demo fan", 2);
  const wheel = mockGetWheel();
  const fansBefore = mockListFans().length;
  mockSetDemoCreatorActive(false);
  try {
    check("saving a game is refused", forbidden(await saveWheel(wheel)));
    let threw = "";
    try { await createWheel({ name: "nope" }); } catch (e) { threw = e instanceof Error ? e.message : ""; }
    check("creating a game is refused", threw === "forbidden");
    check("setting a game active is refused", forbidden(await setActiveWheel(wheel.id!)));
    check("archiving a game is refused", forbidden(await archiveWheel(wheel.id!)));
    check("the display name is refused", forbidden(await setMyDisplayName("Nope")));
    check("the brand colour is refused", forbidden(await setActiveWheelBrandColor("#ec4899")));
    check("a campaign is refused", forbidden(await createCampaign("Nope")));
    check("a top-up is refused", forbidden(await grantSpins(fan.token, 3)));
    check("blocking a fan is refused", forbidden(await setFanBlocked(fan.fanId, true)));
    check("switching a link is refused", forbidden(await updateFanLink(fan.fanId, fan.token, { active: false })));
    check("a queue change is refused", forbidden(await patchRedemption("any", { status: "in_progress" })));
    check("a message is refused", forbidden(await sendCreatorMessage(fan.fanId, "hi")));
    check("the public page is refused", forbidden(await setMyPublicProfile({ tagline: "nope" })));
    check("a webhook is refused", forbidden(await createWebhook("https://example.com/hook")));
    check("nothing was written", mockListFans().length === fansBefore && mockGetWheel().title === wheel.title);
  } finally {
    mockSetDemoCreatorActive(true);
  }
  check("a reactivated creator saves again", "ok" in (await setMyPublicProfile({ tagline: "back" })));
  check("and tops up again", !forbidden(await grantSpins(fan.token, 1)));
  console.log(`suspendedDemo: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
