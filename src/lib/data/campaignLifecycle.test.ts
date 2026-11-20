import assert from "node:assert/strict";
import { mock } from "node:test";
import { FakeSupabase } from "./fakeSupabase";

// A28: a campaign can be archived and reactivated through the existing card
// PATCH, scoped to the signed-in creator exactly like rename and pin. Another
// creator's campaign is "not found" and nothing is written (negative test);
// a non-boolean isActive is a bad request; the demo store keeps parity.
const OWNER = "a0000000-0000-4000-8000-000000000001";
const OTHER = "b0000000-0000-4000-8000-000000000002";
const db = new FakeSupabase(OWNER);
let useSupabase = true;
mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => useSupabase,
    createClient: async () => db.client(),
    createServiceClient: () => { throw new Error("archiving a campaign never needs the service role"); },
  },
});

let passed = 0;
const check = (label: string, condition: unknown) => { assert.ok(condition, label); passed++; };

async function main() {
  const mine = db.seed("campaigns", { creator_id: OWNER, name: "Launch", is_active: true, pinned_wheel_id: null });
  const theirs = db.seed("campaigns", { creator_id: OTHER, name: "Theirs", is_active: true, pinned_wheel_id: null });
  const { setCampaignActive, listCampaigns, createCampaign } = await import("./index");
  const { PATCH } = await import("../../app/api/campaigns/[id]/route");
  const patch = (id: string, body: unknown) =>
    PATCH(new Request(`http://localhost/api/campaigns/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });

  let res = await patch(String(mine.id), { isActive: false });
  check("archive: 200", res.status === 200);
  check("archive: is_active is false", db.row("campaigns", String(mine.id)).is_active === false);
  res = await patch(String(mine.id), { isActive: true });
  check("reactivate: 200 and is_active true", res.status === 200 && db.row("campaigns", String(mine.id)).is_active === true);

  res = await patch(String(mine.id), { isActive: "false" });
  check("a non-boolean isActive is 400 and writes nothing", res.status === 400 && db.row("campaigns", String(mine.id)).is_active === true);
  res = await patch(String(mine.id), { isActive: false, name: "Launch (old)" });
  check("archive + rename apply together", res.status === 200 && db.row("campaigns", String(mine.id)).is_active === false && db.row("campaigns", String(mine.id)).name === "Launch (old)");

  // Negative: another creator's campaign.
  res = await patch(String(theirs.id), { isActive: false });
  check("cannot archive another creator's campaign (404)", res.status === 404 && db.row("campaigns", String(theirs.id)).is_active === true);
  const cross = await setCampaignActive(String(theirs.id), false);
  check("data layer cannot archive another creator's campaign", "error" in cross && cross.error === "not_found" && db.row("campaigns", String(theirs.id)).is_active === true);

  // Demo parity.
  useSupabase = false;
  const made = await createCampaign("Demo launch", null);
  assert.ok("campaign" in made, "the demo store creates a campaign");
  const first = made.campaign;
  res = await patch(first.id, { isActive: false });
  check("demo: archive is 200", res.status === 200);
  check("demo: the list shows it archived", (await listCampaigns()).find((c) => c.id === first.id)?.isActive === false);
  res = await patch(first.id, { isActive: true });
  check("demo: reactivate restores it", res.status === 200 && (await listCampaigns()).find((c) => c.id === first.id)?.isActive === true);
  res = await patch("camp-nope", { isActive: false });
  check("demo: unknown campaign is 404", res.status === 404);

  console.log(`campaign lifecycle: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
