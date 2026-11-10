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
let orgCreateError: { code: string; message: string } | null = null;
const orgCreates: { p_name: string }[] = [];
mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => configured,
    createClient: async () => {
      const client = signedIn ? db.client() : { ...db.client(), auth: { getUser: async () => ({ data: { user: null }, error: null }) } };
      // org_create is answered here so a refusal can carry its SQLSTATE.
      return {
        ...client,
        rpc: async (name: string, args: unknown) => {
          if (name !== "org_create") return client.rpc(name, args);
          orgCreates.push(args as { p_name: string });
          return orgCreateError ? { data: null, error: orgCreateError } : { data: org, error: null };
        },
      };
    },
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

  // Creating an agency: a refusal is said as what it is, never "db_error".
  const { createOrg } = await import("./admin");
  for (const name of ["FanFunnel Support", "Supp0rt Team", "admin"]) {
    const refused = await createOrg(name);
    check(`an agency called ${JSON.stringify(name)} is refused as reserved`, "error" in refused && refused.error === "name_reserved");
  }
  check("…before the database is asked", orgCreates.length === 0);
  check("an ordinary agency name is created", "ok" in (await createOrg("Northside Talent")) && orgCreates.length === 1 && orgCreates[0].p_name === "Northside Talent");
  orgCreateError = { code: "42501", message: "account is not active" };
  let created = await createOrg("Northside Talent");
  check("a suspended or unapproved account is refused as forbidden, not a database fault", "error" in created && created.error === "forbidden");
  orgCreateError = { code: "22023", message: "agency name is reserved" };
  created = await createOrg("Northside Talent");
  check("the database's own reserved-name refusal is name_reserved", "error" in created && created.error === "name_reserved");
  orgCreateError = { code: "22023", message: "invalid agency name" };
  created = await createOrg("Northside Talent");
  check("any other refused name is invalid_name", "error" in created && created.error === "invalid_name");
  orgCreateError = { code: "57014", message: "canceling statement due to statement timeout" };
  created = await createOrg("Northside Talent");
  check("a real fault stays db_error", "error" in created && created.error === "db_error");
  orgCreateError = null;

  signedIn = false;
  check("signed out: nothing is read", (await getManagedOrgState(org)).orgName === null);
  signedIn = true;
  configured = false;
  check("the demo has no agencies", (await getManagedOrgState(org)).orgName === null);
  check("the service role is never used for it", serviceUses === 0);
  console.log(`agencyOwnerActive: ${passed} checks passed`);
}
main().catch((error) => { console.error(error); process.exit(1); });
