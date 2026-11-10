import assert from "node:assert/strict";
import { mock } from "node:test";
import { FakeSupabase } from "./fakeSupabase";

// WG-13: a managed creator is told when its agency's owner is suspended. The
// answer comes from orgs.owner_active (0073: trigger-maintained, readable by
// the owner, its seats and its managed creators), never from the owner's
// profile row, and "unknown" is never shown as "suspended".

let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };

const me = "00000000-0000-4000-8000-0000000000c1";
const org = "00000000-0000-4000-8000-00000000000f";
const oldOrg = "00000000-0000-4000-8000-00000000000e";
const db = new FakeSupabase(me);
db.tables.orgs = [];
db.seed("orgs", { id: org, name: "Northside Talent", owner_id: "00000000-0000-4000-8000-0000000000a1", owner_active: false });
db.seed("orgs", { id: oldOrg, name: "Before 0073", owner_id: "00000000-0000-4000-8000-0000000000a2" });

let configured = true;
let signedIn = true;
let serviceUses = 0;
mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => configured,
    createClient: async () => (signedIn ? db.client() : { ...db.client(), auth: { getUser: async () => ({ data: { user: null }, error: null }) } }),
    createServiceClient: () => { serviceUses++; throw new Error("the owner's standing is a session read"); },
  },
});

async function main() {
  const { getManagedOrgState } = await import("./admin");
  let state = await getManagedOrgState(org);
  check("a suspended owner is reported as not active, with the agency's name", state.ownerActive === false && state.orgName === "Northside Talent");
  db.tables.orgs[0].owner_active = true;
  state = await getManagedOrgState(org);
  check("an owner in good standing is active", state.ownerActive === true);
  state = await getManagedOrgState(oldOrg);
  check("a database without the column is unknown (null), not suspended", state.ownerActive === null && state.orgName === "Before 0073");
  state = await getManagedOrgState("00000000-0000-4000-8000-0000000000ff");
  check("an agency this session cannot read is unknown", state.ownerActive === null && state.orgName === null);
  check("no agency: nothing to say", (await getManagedOrgState(null)).ownerActive === null);
  signedIn = false;
  check("signed out: nothing is read", (await getManagedOrgState(org)).orgName === null);
  signedIn = true;
  configured = false;
  check("the demo has no agencies", (await getManagedOrgState(org)).orgName === null);
  check("the service role is never used for it", serviceUses === 0);
  console.log(`agencyOwnerActive: ${passed} checks passed`);
}
main().catch((error) => { console.error(error); process.exit(1); });
