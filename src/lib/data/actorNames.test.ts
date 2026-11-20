import assert from "node:assert/strict";
import { mock } from "node:test";
import { FakeSupabase } from "./fakeSupabase";

// WG-07: "via <name>" names only the creator's own agency team. A profile
// outside that agency (a removed seat, another tenant, support) is never
// named, an e-mail address is never a name, and the creator's own writes
// carry no line.

let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };

const creator = "00000000-0000-4000-8000-0000000000c1";
const loner = "00000000-0000-4000-8000-0000000000c2";
const chatter = "00000000-0000-4000-8000-0000000000a1";
const owner = "00000000-0000-4000-8000-0000000000a2";
const outsider = "00000000-0000-4000-8000-0000000000b1";
const mailName = "00000000-0000-4000-8000-0000000000a3";
const org = "00000000-0000-4000-8000-00000000000f";
const otherOrg = "00000000-0000-4000-8000-00000000000e";

const db = new FakeSupabase(creator);
db.tables.profiles = []; db.tables.org_members = []; db.tables.orgs = []; db.tables.messages = [];
db.seed("profiles", { id: creator, display_name: "Creator", org_id: org });
db.seed("profiles", { id: loner, display_name: "Loner", org_id: null });
db.seed("profiles", { id: chatter, display_name: "Robin Chatter", org_id: null });
db.seed("profiles", { id: owner, display_name: "Olive Owner", org_id: null });
db.seed("profiles", { id: outsider, display_name: "Other Tenant Staff", org_id: null });
db.seed("profiles", { id: mailName, display_name: "someone@example.com", org_id: null });
db.seed("orgs", { id: org, owner_id: owner, name: "Agency" });
db.seed("orgs", { id: otherOrg, owner_id: outsider, name: "Other" });
db.seed("org_members", { org_id: org, profile_id: chatter, role: "chatter" });
db.seed("org_members", { org_id: org, profile_id: mailName, role: "chatter" });
db.seed("org_members", { org_id: otherOrg, profile_id: outsider, role: "manager" });

let serviceUses = 0;
let serviceWorks = true;
mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => true,
    createClient: async () => db.client(),
    createServiceClient: () => { serviceUses++; if (!serviceWorks) throw new Error("no service key"); return db.client(); },
  },
});

let allowed: unknown = true;
db.rpcHandlers.can_act_for = () => allowed;

async function main() {
  const { actorNames, resetActorNameCache, TEAM_MEMBER } = await import("./actorNames");

  let names = await actorNames(db.client(), creator, "view", [chatter, owner, outsider, mailName, creator, null, undefined, chatter]);
  check("a seat in the creator's agency is named", names.get(chatter) === "Robin Chatter");
  check("the agency owner is named", names.get(owner) === "Olive Owner");
  check("a profile outside the agency is never named", names.get(outsider) === TEAM_MEMBER);
  check("an e-mail address is never used as a name", names.get(mailName) === TEAM_MEMBER);
  check("the creator itself gets no line", !names.has(creator) && names.size === 4);

  const uses = serviceUses;
  names = await actorNames(db.client(), creator, "view", [chatter]);
  check("names are cached for a minute", names.get(chatter) === "Robin Chatter" && serviceUses === uses);
  names = await actorNames(db.client(), creator, "view", [chatter], Date.now() + 61_000);
  check("…and read again after it", serviceUses === uses + 1);

  resetActorNameCache();
  names = await actorNames(db.client(), loner, "view", [chatter, owner]);
  check("a creator in no agency sees the neutral label only", names.get(chatter) === TEAM_MEMBER && names.get(owner) === TEAM_MEMBER);

  resetActorNameCache();
  const before = serviceUses;
  names = await actorNames(db.client(), creator, "view", [creator, null]);
  check("nothing to resolve never touches the service role", names.size === 0 && serviceUses === before);

  serviceWorks = false;
  names = await actorNames(db.client(), creator, "view", [chatter]);
  check("without the service key everyone keeps the neutral label", names.get(chatter) === TEAM_MEMBER);
  serviceWorks = true;
  resetActorNameCache();

  // The session's own proof comes first, every time: no proof, no service read, no names.
  {
    const proofs = () => db.rpcCalls.filter((c) => c.name === "can_act_for").length;
    let usesBefore = serviceUses;
    let proofsBefore = proofs();
    names = await actorNames(db.client(), creator, "view", [chatter]);
    check("the session proves can_act_for(creator, 'view') before the service role is used", proofs() === proofsBefore + 1 && serviceUses === usesBefore + 1 && db.rpcCalls.at(-1)?.args.perm === "view" && db.rpcCalls.at(-1)?.args.target_creator === creator);
    for (const [label, answer] of [["a suspended or unapproved session", false], ["a null answer", null], ["a truthy non-boolean answer", "true"]] as const) {
      allowed = answer;
      usesBefore = serviceUses;
      names = await actorNames(db.client(), creator, "view", [chatter, owner]);
      check(`${label} gets no names and never reaches the service role (even with a warm cache)`, names.size === 0 && serviceUses === usesBefore);
    }
    allowed = true;
    db.rpcHandlers.can_act_for = () => { throw new Error("rpc down"); };
    usesBefore = serviceUses;
    names = await actorNames(db.client(), creator, "chat", [chatter]);
    check("a failed permission read is a refusal, not a pass", names.size === 0 && serviceUses === usesBefore);
    db.rpcHandlers.can_act_for = () => allowed;
    proofsBefore = proofs();
    names = await actorNames(db.client(), creator, "view", [creator, null]);
    check("nothing to resolve asks nothing", names.size === 0 && proofs() === proofsBefore);
    resetActorNameCache();
  }

  // The creator-side thread read carries the line; the creator's own replies do not.
  const fan = "00000000-0000-4000-8000-0000000000f1";
  db.seed("messages", { creator_id: creator, fan_id: fan, sender: "fan", body: "hi", created_at: "2026-11-10T10:00:00.000Z", read_at: null, actor_id: null });
  db.seed("messages", { creator_id: creator, fan_id: fan, sender: "creator", body: "mine", created_at: "2026-11-10T10:01:00.000Z", read_at: null, actor_id: creator });
  db.seed("messages", { creator_id: creator, fan_id: fan, sender: "creator", body: "from the team", created_at: "2026-11-10T10:02:00.000Z", read_at: null, actor_id: chatter });
  db.seed("messages", { creator_id: creator, fan_id: fan, sender: "creator", body: "from a stranger", created_at: "2026-11-10T10:03:00.000Z", read_at: null, actor_id: outsider });
  const { getThreadPage } = await import("./inbox");
  const page = await getThreadPage(fan);
  assert.ok(!("error" in page));
  const by = Object.fromEntries(page.messages.map((m) => [m.body, m.via]));
  check("a team reply says who sent it", by["from the team"] === "Robin Chatter");
  check("the creator's own reply and the fan's message carry no line", by.mine === undefined && by.hi === undefined);
  check("a reply by someone outside the agency shows the neutral label", by["from a stranger"] === TEAM_MEMBER);

  console.log(`actorNames.test: ${passed} checks passed`);
}
main().catch((error) => { console.error(error); process.exit(1); });
