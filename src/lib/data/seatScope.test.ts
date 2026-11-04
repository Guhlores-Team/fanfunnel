import assert from "node:assert";
import { mock } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// A19 negative + positive tests: a staff seat acts for a creator in its agency
// only through the job can_act_for allows on its own session (chatter: inbox,
// fulfiller: prize queue, manager: both). A refused request never reaches a
// table or the queue/inbox RPC; an allowed one is scoped to that creator. The
// database half (RLS + the 0066 RPCs, acting as real seats) is
// scripts/db/seatScopeProbe.mjs, run by schema-drift-check.mjs.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const USER = "aaaaaaaa-0000-4000-8000-000000000001";
const C = "cccccccc-0000-4000-8000-000000000001"; // in scope
const D = "dddddddd-0000-4000-8000-000000000001"; // same agency, not in scope
const FAN = "ffffffff-0000-4000-8000-000000000001";
const RID = "eeeeeeee-0000-4000-8000-000000000001"; // a won prize (redemption)
type Op = { name: string; args: unknown[] };
let perms = new Set<string>(); // "creator:perm" the caller holds
const rpcs: { name: string; args: Record<string, unknown> }[] = [];
const reads: { table: string; ops: Op[] }[] = [];
let signedIn = true;

function session() {
  const from = (table: string) => {
    const ops: Op[] = [];
    reads.push({ table, ops });
    const proxy: unknown = new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") {
          return (res: (v: unknown) => unknown) => {
            const single = ops.some((o) => o.name === "maybeSingle");
            const data = table === "fans" ? { id: FAN } : table === "redemptions" ? { id: "r1" } : single ? null : [];
            return Promise.resolve({ data, error: null }).then(res);
          };
        }
        return (...args: unknown[]) => { ops.push({ name: String(prop), args }); return proxy; };
      },
    });
    return proxy;
  };
  return {
    auth: { getUser: async () => ({ data: { user: signedIn ? { id: USER } : null }, error: null }) },
    rpc: async (name: string, args: Record<string, unknown> = {}) => {
      rpcs.push({ name, args });
      if (name === "can_act_for") return { data: perms.has(`${args.target_creator}:${args.perm}`), error: null };
      if (name === "set_redemption_state") return { data: { status: "ok", stock: "none" }, error: null };
      if (name === "my_seat_creators") return { data: [{ creator_id: C, display_name: "Creator C", can_chat: true, can_fulfil: false }], error: null };
      return { data: [], error: null };
    },
    from,
  };
}
mock.module("@/lib/supabase/server", {
  namedExports: { isSupabaseConfigured: () => true, createClient: async () => session(), createServiceClient: () => session() },
});

const writes = (table: string) => reads.filter((r) => r.table === table && r.ops.some((o) => ["insert", "update", "delete"].includes(o.name)));
const eqCreator = (r: { ops: Op[] }) => r.ops.find((o) => o.name === "eq" && o.args[0] === "creator_id")?.args[1];
const reset = () => { rpcs.length = 0; reads.length = 0; };
const dataRpcs = () => rpcs.filter((r) => r.name !== "can_act_for");
// 0067: a prize is written through set_redemption_state, never the table.
const prizeWrites = () => rpcs.filter((r) => r.name === "set_redemption_state");

async function main() {
  const { resolveActingCreator, listMySeatCreators } = await import("./seatScope");
  const inbox = await import("./inbox");
  const fulfil = await import("./fulfilment");
  const { listRedemptionQueue } = await import("./redemptionQueue");

  // --- the resolver ---------------------------------------------------------------
  const sb = session();
  for (const self of [undefined, null, "", USER]) {
    reset();
    const r = await resolveActingCreator(sb, USER, self, "chat");
    check(`no creator named (${JSON.stringify(self)}) → the caller's own account, no permission call`, "creatorId" in r && r.creatorId === USER && rpcs.length === 0);
  }
  for (const bad of ["x", 42, { id: C }, `${C}' or 1=1`]) {
    reset();
    const r = await resolveActingCreator(sb, USER, bad, "chat");
    check(`a malformed creator id (${JSON.stringify(bad)}) is a bad request, never a lookup`, "error" in r && r.error === "bad_request" && rpcs.length === 0);
  }
  perms = new Set([`${C}:chat`]);
  reset();
  let r = await resolveActingCreator(sb, USER, C, "chat");
  check("a seat holding the job gets that creator", "creatorId" in r && r.creatorId === C);
  check("…checked with can_act_for on the caller's session for exactly that job", rpcs.length === 1 && rpcs[0].args.target_creator === C && rpcs[0].args.perm === "chat");
  r = await resolveActingCreator(sb, USER, C, "fulfil");
  check("the same seat without the fulfil job is refused", "error" in r && r.error === "forbidden");
  r = await resolveActingCreator(sb, USER, D, "chat");
  check("a creator outside the seat's scope is refused", "error" in r && r.error === "forbidden");
  const failing = { rpc: async () => ({ data: null, error: { message: "boom" } }) };
  r = await resolveActingCreator(failing, USER, C, "chat");
  check("a permission-check error fails closed", "error" in r && r.error === "forbidden");

  // --- a CHATTER scoped to C ------------------------------------------------------
  perms = new Set([`${C}:chat`]);
  reset();
  const threads = await inbox.listThreads(undefined, undefined, C);
  check("chatter: C's inbox is read through the RPC with p_creator = C", !("error" in threads) && dataRpcs().length === 1 && dataRpcs()[0].name === "creator_inbox_threads" && dataRpcs()[0].args.p_creator === C);
  reset();
  const thread = await inbox.getThread(FAN, C);
  check("chatter: C's thread is read and marked read for C only", Array.isArray(thread) && reads.filter((x) => x.table === "messages").every((x) => eqCreator(x) === C) && reads.some((x) => x.table === "messages"));
  reset();
  const sent = await inbox.sendCreatorMessage(FAN, "hello from the agency", C);
  check("chatter: the reply is written as C's message to C's fan", "ok" in sent && writes("messages").length === 1 && (writes("messages")[0].ops.find((o) => o.name === "insert")?.args[0] as { creator_id: string }).creator_id === C);
  check("chatter: the fan is checked to belong to C first", reads.some((x) => x.table === "fans" && eqCreator(x) === C));
  reset();
  let denied = await fulfil.setRedemptionStatus(RID, "fulfilled", C);
  check("chatter: marking C's prize fulfilled is refused (403)", "error" in denied && denied.error === "forbidden");
  check("…before any write", writes("redemptions").length === 0 && prizeWrites().length === 0);
  denied = await fulfil.setRedemptionMeta(RID, { notes: "x" }, C);
  check("chatter: editing C's prize notes is refused before any write", "error" in denied && denied.error === "forbidden" && writes("redemptions").length === 0 && prizeWrites().length === 0);
  reset();
  const queue = await listRedemptionQueue({ creatorId: C });
  check("chatter: C's prize queue is refused and the queue RPC is never called", "error" in queue && queue.error === "forbidden" && dataRpcs().length === 0);

  // --- a FULFILLER scoped to C ----------------------------------------------------
  perms = new Set([`${C}:fulfil`]);
  reset();
  const q2 = await listRedemptionQueue({ creatorId: C, status: "pending" });
  check("fulfiller: C's queue is read through the RPC with p_creator = C", !("error" in q2) && dataRpcs().length === 1 && dataRpcs()[0].name === "creator_redemption_queue" && dataRpcs()[0].args.p_creator === C);
  reset();
  const done = await fulfil.setRedemptionStatus(RID, "fulfilled", C);
  check("fulfiller: C's prize is updated, scoped to C", "ok" in done && prizeWrites().length === 1 && prizeWrites()[0].args.p_creator === C && prizeWrites()[0].args.p_redemption === RID && writes("redemptions").length === 0);
  reset();
  const t2 = await inbox.listThreads(undefined, undefined, C);
  check("fulfiller: C's inbox is refused, no inbox RPC", "error" in t2 && t2.error === "forbidden" && dataRpcs().length === 0);
  const g2 = await inbox.getThread(FAN, C);
  check("fulfiller: C's thread is refused before any read", !Array.isArray(g2) && g2.error === "forbidden" && !reads.some((x) => x.table === "messages"));
  const s2 = await inbox.sendCreatorMessage(FAN, "nope", C);
  check("fulfiller: a reply for C is refused before any write", "error" in s2 && s2.error === "forbidden" && writes("messages").length === 0);

  // --- a MANAGER (both jobs) and the unscoped creator D --------------------------
  perms = new Set([`${C}:chat`, `${C}:fulfil`]);
  reset();
  check("manager: inbox and queue for C both work", !("error" in (await inbox.listThreads(undefined, undefined, C))) && !("error" in (await listRedemptionQueue({ creatorId: C }))));
  reset();
  const outside = [await inbox.listThreads(undefined, undefined, D), await listRedemptionQueue({ creatorId: D }), await fulfil.setRedemptionStatus(RID, "fulfilled", D), await inbox.sendCreatorMessage(FAN, "x", D)];
  check("nobody acts for a creator outside their scope (inbox, queue, fulfil, reply)", outside.every((x) => "error" in x && x.error === "forbidden") && dataRpcs().length === 0 && writes("redemptions").length === 0 && writes("messages").length === 0);

  // --- own account is unchanged ---------------------------------------------------
  perms = new Set();
  reset();
  const own = await inbox.listThreads();
  check("own inbox: no permission call and no p_creator (0064 behaviour)", !("error" in own) && !rpcs.some((x) => x.name === "can_act_for") && dataRpcs()[0].args.p_creator === undefined);
  reset();
  await fulfil.setRedemptionStatus(RID, "fulfilled");
  check("own prize: scoped to the caller", prizeWrites().length === 1 && prizeWrites()[0].args.p_creator === USER);

  // --- the seat list --------------------------------------------------------------
  reset();
  const seats = await listMySeatCreators();
  check("seat list comes from my_seat_creators on the caller's session", Array.isArray(seats) && seats[0].creatorId === C && seats[0].canChat && !seats[0].canFulfil && rpcs[0].name === "my_seat_creators");
  signedIn = false;
  check("signed out: no seat list", JSON.stringify(await listMySeatCreators()) === '{"error":"unauthorized"}');
  signedIn = true;

  // --- routes ---------------------------------------------------------------------
  perms = new Set([`${C}:chat`]);
  const { GET: inboxGET } = await import("@/app/api/messages/inbox/route");
  const { GET: queueGET, POST: queuePOST } = await import("@/app/api/redemptions/route");
  const { PATCH } = await import("@/app/api/redemptions/[id]/route");
  const req = (url: string, init?: RequestInit) => new Request(`http://localhost${url}`, init);
  check("route: a chatter reading C's inbox → 200", (await inboxGET(req(`/api/messages/inbox?creatorId=${C}`))).status === 200);
  check("route: a chatter reading D's inbox → 403", (await inboxGET(req(`/api/messages/inbox?creatorId=${D}`))).status === 403);
  check("route: a chatter reading C's prize queue → 403", (await queueGET(req(`/api/redemptions?creatorId=${C}`))).status === 403);
  reset();
  const post = await queuePOST(req("/api/redemptions", { method: "POST", body: JSON.stringify({ id: RID, status: "fulfilled", creatorId: C }) }));
  check("route: a chatter fulfilling C's prize → 403 with no write", post.status === 403 && writes("redemptions").length === 0 && prizeWrites().length === 0);
  reset();
  const patch = await PATCH(req(`/api/redemptions/${RID}`, { method: "PATCH", body: JSON.stringify({ status: "fulfilled", notes: "n", creatorId: C }) }), { params: Promise.resolve({ id: RID }) });
  check("route: a chatter patching C's prize → 403 with no write", patch.status === 403 && writes("redemptions").length === 0 && prizeWrites().length === 0);
  perms = new Set([`${C}:fulfil`]);
  reset();
  const ok = await PATCH(req(`/api/redemptions/${RID}`, { method: "PATCH", body: JSON.stringify({ status: "fulfilled", creatorId: C }) }), { params: Promise.resolve({ id: RID }) });
  check("route: a fulfiller patching C's prize → 200, scoped to C", ok.status === 200 && prizeWrites().length === 1 && prizeWrites()[0].args.p_creator === C && writes("redemptions").length === 0);

  // --- wiring ---------------------------------------------------------------------
  const root = join(import.meta.dirname, "../../..");
  const ws = readFileSync(join(root, "src/components/agency/SeatWorkspace.tsx"), "utf8");
  check("the seat workspace names the creator on every inbox/queue request", (ws.match(/seatPath\(/g) ?? []).length >= 3 && /JSON\.stringify\(\{ fanId, body: draft, creatorId \}\)/.test(ws) && /JSON\.stringify\(\{ id, status: "fulfilled", creatorId \}\)/.test(ws));
  check("the agency console renders the seat workspace", /<SeatWorkspace \/>/.test(readFileSync(join(root, "src/components/agency/AgencyClient.tsx"), "utf8")));
  const { seatTabs, seatPath } = await import("@/components/agency/seatWorkspace");
  check("tabs follow the jobs: chatter inbox only, fulfiller prizes only, manager both",
    seatTabs({ canChat: true, canFulfil: false }).join() === "inbox" && seatTabs({ canChat: false, canFulfil: true }).join() === "prizes" && seatTabs({ canChat: true, canFulfil: true }).join() === "inbox,prizes");
  check("seatPath appends the creator to either form of URL", seatPath("/a", C) === `/a?creatorId=${C}` && seatPath("/a?x=1", C) === `/a?x=1&creatorId=${C}`);

  console.log(`seatScope.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
