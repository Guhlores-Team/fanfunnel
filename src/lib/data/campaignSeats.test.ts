import assert from "node:assert/strict";
import { mock } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FakeSupabase } from "./fakeSupabase";

// A28 residual (agency seats on campaigns), negative + positive. A seat runs a
// creator's campaigns only with can_act_for(creator, 'manage') on its own
// session (agency owners and managers). A refused request never touches the
// campaigns or wheels tables; an allowed one is scoped to that creator; the
// owner path (no creatorId, or the caller's own id) makes no permission call
// and behaves as before. The database half (campaigns RLS + can_act_for,
// acting as real seats, suspended and removed seats included) is
// scripts/db/seatScopeProbe.mjs, run by schema-drift-check.mjs.

const USER = "aaaaaaaa-0000-4000-8000-000000000001"; // the caller
const C = "cccccccc-0000-4000-8000-000000000001"; // creator in the seat's scope
const D = "dddddddd-0000-4000-8000-000000000001"; // same agency, not in scope
const X = "eeeeeeee-0000-4000-8000-000000000001"; // unrelated creator
const db = new FakeSupabase(USER);
let useSupabase = true;
let perms = new Set<string>(); // "creator:perm" the caller holds right now
db.rpcHandlers.can_act_for = (a) => {
  const { target_creator, perm } = a as { target_creator: string; perm: string };
  return target_creator === USER || perms.has(`${target_creator}:${perm}`);
};
db.rpcHandlers.my_seat_creators = () => [
  { creator_id: C, display_name: "Creator C", can_chat: true, can_fulfil: true },
  { creator_id: D, display_name: "Creator D", can_chat: true, can_fulfil: false },
];
// 0071: a campaign is deleted through delete_campaign (sessions can no longer
// DELETE campaigns). The fake models the RPC: only the named creator's row.
db.rpcHandlers.delete_campaign = (a) => {
  const { p_campaign, p_creator } = a as { p_campaign: string; p_creator: string };
  const before = db.rows("campaigns").length;
  db.tables.campaigns = db.rows("campaigns").filter((r) => !(r.id === p_campaign && r.creator_id === p_creator));
  return db.rows("campaigns").length < before ? "ok" : "not_found";
};
const deleteCalls = () => db.rpcCalls.filter((r) => r.name === "delete_campaign");
mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => useSupabase,
    createClient: async () => db.client(),
    createServiceClient: () => { throw new Error("campaign seats never need the service role"); },
  },
});

let passed = 0;
const check = (label: string, condition: unknown) => { assert.ok(condition, label); passed++; };
const permCalls = () => db.rpcCalls.filter((r) => r.name === "can_act_for");
const touched = (table: string, from: number) => db.statements.slice(from).filter((s) => s.table === table);
const campaignWrites = (from: number) => touched("campaigns", from).filter((s) => s.op !== "select");

async function main() {
  const wheel = (id: string, creator: string, title: string) => db.seed("wheels", { id, creator_id: creator, title, archived_at: null, game_kind: "wheel", game_ready: true, is_active: true });
  const wC = wheel("b0000000-0000-4000-8000-0000000000c1", C, "C's wheel");
  const wD = wheel("b0000000-0000-4000-8000-0000000000d1", D, "D's wheel");
  const wOwn = wheel("b0000000-0000-4000-8000-0000000000a1", USER, "My wheel");
  const camp = (creator: string, name: string) => db.seed("campaigns", { creator_id: creator, name, is_active: true, pinned_wheel_id: null });
  const cC = camp(C, "C launch");
  const cD = camp(D, "D launch");
  const cX = camp(X, "X launch");
  const cOwn = camp(USER, "My launch");

  const { GET, POST } = await import("@/app/api/campaigns/route");
  const { PATCH, DELETE } = await import("@/app/api/campaigns/[id]/route");
  const data = await import("./index");
  const { listMySeatCreators } = await import("./seatScope");
  const req = (url: string, init?: RequestInit) => new Request(`http://localhost${url}`, init);
  const json = (method: string, body: unknown) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const patch = (id: unknown, body: unknown) => PATCH(req(`/api/campaigns/${id}`, json("PATCH", body)), { params: Promise.resolve({ id: String(id) }) });
  const del = (id: unknown, creator?: string) => DELETE(req(`/api/campaigns/${id}${creator ? `?creatorId=${creator}` : ""}`, { method: "DELETE" }), { params: Promise.resolve({ id: String(id) }) });
  const list = (creator: string) => GET(req(`/api/campaigns?creatorId=${encodeURIComponent(creator)}`));
  const create = (body: unknown) => POST(req("/api/campaigns", json("POST", body)));

  // --- refused seats: every route, before any campaign/wheel statement ----------
  const refusedEverywhere = async (who: string, creator: string) => {
    const mark = db.statements.length;
    const deletesBefore = deleteCalls().length;
    const before = JSON.stringify(db.rows("campaigns"));
    const statuses = [
      (await list(creator)).status,
      (await create({ name: "Sneaky", creatorId: creator })).status,
      (await patch(cC.id, { name: "Hijacked", creatorId: creator })).status,
      (await patch(cC.id, { isActive: false, creatorId: creator })).status,
      (await patch(cC.id, { pinnedWheelId: wC.id, creatorId: creator })).status,
      (await patch(cC.id, { creatorId: creator })).status, // a no-op is refused too
      (await del(cC.id, creator)).status,
    ];
    check(`${who}: list, create, rename, archive, pin, no-op and delete are all 403`, statuses.every((s) => s === 403));
    check(`${who}: …without reading or writing campaigns or wheels`, touched("campaigns", mark).length === 0 && touched("wheels", mark).length === 0);
    check(`${who}: …and every campaign row is unchanged`, JSON.stringify(db.rows("campaigns")) === before);
    const direct = [
      await data.renameCampaign(String(cC.id), "x", creator),
      await data.setCampaignActive(String(cC.id), false, creator),
      await data.setCampaignPinnedWheel(String(cC.id), null, creator),
      await data.deleteCampaign(String(cC.id), creator),
      await data.createCampaign("x", null, creator),
      await data.listActingCampaigns(creator),
    ];
    check(`${who}: the data layer refuses the same way (forbidden)`, direct.every((r) => "error" in r && r.error === "forbidden") && campaignWrites(mark).length === 0);
    check(`${who}: …and never reaches delete_campaign`, deleteCalls().length === deletesBefore);
  };

  // A chatter + fulfiller for C (every job but manage).
  perms = new Set([`${C}:chat`, `${C}:fulfil`, `${C}:view`]);
  await refusedEverywhere("a seat without manage", C);
  check("…asked can_act_for for 'manage' on C, nothing else", permCalls().every((r) => r.args.perm === "manage") && permCalls().some((r) => r.args.target_creator === C));

  // A manager of C naming D (same agency, not in its scope) or X (unrelated).
  perms = new Set([`${C}:manage`]);
  await refusedEverywhere("a manager of C acting for D (outside its scope)", D);
  await refusedEverywhere("a manager of C acting for an unrelated creator", X);

  // A seat that was suspended or removed: can_act_for returns false for it
  // (the DB probe proves that half against the real function).
  perms = new Set();
  await refusedEverywhere("a suspended or removed seat", C);

  // Malformed creator ids are a 400 before any lookup.
  for (const bad of ["not-a-uuid", `${C}' or 1=1`]) {
    const calls = permCalls().length;
    const mark = db.statements.length;
    const statuses = [(await list(bad)).status, (await create({ name: "x", creatorId: bad })).status, (await patch(cC.id, { name: "x", creatorId: bad })).status, (await del(cC.id, bad)).status];
    check(`a malformed creatorId (${bad}) is 400 everywhere, with no permission call and no read`, statuses.every((s) => s === 400) && permCalls().length === calls && db.statements.length === mark);
  }
  check("an over-long creatorId is a 400", (await list("a".repeat(65))).status === 400 && (await del(cC.id, "a".repeat(65))).status === 400);

  // --- a manager of C: the whole lifecycle, scoped to C --------------------------
  perms = new Set([`${C}:manage`]);
  let mark = db.statements.length;
  let res = await list(C);
  const listed = (await res.json()) as { campaigns: { id: string }[]; games: { id: string }[] };
  check("manager: C's campaigns are listed (and only C's)", res.status === 200 && listed.campaigns.map((c) => c.id).join() === String(cC.id));
  check("manager: C's games come with them for the picker (and only C's)", listed.games.map((g) => g.id).join() === String(wC.id));
  check("manager: both reads are filtered to creator C", touched("campaigns", mark).concat(touched("wheels", mark)).every((s) => s.filters.some((f) => f.col === "creator_id" && f.value === C)));

  res = await create({ name: "C summer", creatorId: C, pinnedWheelId: wC.id });
  const made = ((await res.json()) as { campaign: { id: string } }).campaign;
  check("manager: creates a campaign owned by C, playing C's game", res.status === 200 && db.row("campaigns", made.id).creator_id === C && db.row("campaigns", made.id).pinned_wheel_id === wC.id);
  mark = db.statements.length;
  res = await create({ name: "C steal", creatorId: C, pinnedWheelId: wD.id });
  check("manager: a campaign for C cannot be pointed at D's game (404, nothing inserted)", res.status === 404 && campaignWrites(mark).length === 0);

  res = await patch(cC.id, { name: "C launch (new)", isActive: false, pinnedWheelId: wC.id, creatorId: C });
  const row = db.row("campaigns", String(cC.id));
  check("manager: rename + archive + pin of C's campaign apply together", res.status === 200 && row.name === "C launch (new)" && row.is_active === false && row.pinned_wheel_id === wC.id);
  res = await patch(cC.id, { pinnedWheelId: wOwn.id, creatorId: C });
  check("manager: C's campaign cannot be pinned to the seat's own game (404)", res.status === 404 && db.row("campaigns", String(cC.id)).pinned_wheel_id === wC.id);
  res = await patch(cD.id, { name: "D hijack", creatorId: C });
  check("manager of C: D's campaign id under C is not found and untouched", res.status === 404 && db.row("campaigns", String(cD.id)).name === "D launch");
  await del(cD.id, C);
  check("manager of C: deleting D's campaign id under C deletes nothing", db.rows("campaigns").some((r) => r.id === cD.id));
  res = await del(made.id, C);
  check("manager: deletes C's campaign", res.status === 200 && !db.rows("campaigns").some((r) => r.id === made.id));
  check("manager: every campaign write named creator C", db.statements.filter((s) => s.table === "campaigns" && s.op !== "select" && s.op !== "insert").every((s) => s.filters.some((f) => f.col === "creator_id" && f.value === C)));
  check("manager: both deletes went through delete_campaign naming creator C, none as a plain DELETE",
    deleteCalls().length === 2 && deleteCalls().every((r) => r.args.p_creator === C) && !db.statements.some((s) => s.table === "campaigns" && s.op === "delete"));

  // --- the owner path is unchanged ----------------------------------------------
  perms = new Set();
  for (const self of [undefined, USER]) {
    const calls = permCalls().length;
    mark = db.statements.length;
    res = await patch(cOwn.id, { name: `Mine ${self ?? "plain"}`, ...(self ? { creatorId: self } : {}) });
    check(`owner (${self ? "own id named" : "no creatorId"}): renames their own campaign with no permission call`, res.status === 200 && db.row("campaigns", String(cOwn.id)).name === `Mine ${self ?? "plain"}` && permCalls().length === calls);
    check("owner: the write is filtered to the caller", campaignWrites(mark).every((s) => s.filters.some((f) => f.col === "creator_id" && f.value === USER)));
  }
  res = await GET(req("/api/campaigns"));
  const own = (await res.json()) as { campaigns: { id: string }[]; games?: unknown };
  check("owner: the plain list is the caller's own campaigns, same shape as before (no games)", res.status === 200 && own.campaigns.map((c) => c.id).join() === String(cOwn.id) && own.games === undefined);
  res = await patch(cX.id, { isActive: false });
  check("owner: another creator's campaign is still 404 and untouched", res.status === 404 && db.row("campaigns", String(cX.id)).is_active === true);
  res = await create({ name: "Mine too", pinnedWheelId: wOwn.id });
  const mine = ((await res.json()) as { campaign: { id: string } }).campaign;
  check("owner: creates for themselves", res.status === 200 && db.row("campaigns", mine.id).creator_id === USER);
  res = await del(mine.id);
  check("owner: deletes their own", res.status === 200 && !db.rows("campaigns").some((r) => r.id === mine.id));
  check("owner: the delete names the caller as the creator", deleteCalls().at(-1)?.args.p_creator === USER && deleteCalls().at(-1)?.args.p_campaign === mine.id);
  check("owner: no can_act_for call anywhere on the owner path", permCalls().every((r) => r.args.target_creator !== USER));

  // --- the seat list for the Campaigns picker ------------------------------------
  perms = new Set([`${C}:manage`]);
  let calls = permCalls().length;
  const plain = await listMySeatCreators();
  check("seat list without job=manage: unchanged, no manage flag, no extra permission calls", Array.isArray(plain) && plain.every((s) => s.canManage === undefined) && permCalls().length === calls);
  calls = permCalls().length;
  const managed = await listMySeatCreators({ manage: true });
  check("seat list with manage: C (manager) is manageable, D (chat only) is not", Array.isArray(managed) && managed.find((s) => s.creatorId === C)?.canManage === true && managed.find((s) => s.creatorId === D)?.canManage === false);
  check("…asking can_act_for 'manage' only for rows that hold both jobs", permCalls().length - calls === 1 && permCalls().at(-1)?.args.target_creator === C);
  const { GET: seatsGET } = await import("@/app/api/agency/seats/route");
  const seatsBody = (await (await seatsGET(req("/api/agency/seats?job=manage"))).json()) as { seats: { creatorId: string; canManage?: boolean }[] };
  check("route: /api/agency/seats?job=manage carries canManage", seatsBody.seats.find((s) => s.creatorId === C)?.canManage === true);
  const { manageableSeats } = await import("@/components/agency/seatWorkspace");
  check("the picker lists only creators marked manageable", manageableSeats(seatsBody.seats).map((s) => s.creatorId).join() === C && manageableSeats(null).length === 0);

  // --- demo mode: no agencies -----------------------------------------------------
  useSupabase = false;
  const demoStatuses = [(await list(C)).status, (await create({ name: "x", creatorId: C })).status, (await patch("any", { name: "x", creatorId: C })).status, (await patch("any", { creatorId: C })).status, (await del("any", C)).status];
  check("demo: naming any creator is refused (403) on every campaign route", demoStatuses.every((s) => s === 403));
  const demoOwn = await GET(req("/api/campaigns"));
  check("demo: the plain list still works", demoOwn.status === 200 && Array.isArray(((await demoOwn.json()) as { campaigns: unknown[] }).campaigns));
  useSupabase = true;

  // --- wiring ---------------------------------------------------------------------
  const root = join(import.meta.dirname, "../../..");
  const panel = readFileSync(join(root, "src/components/dashboard/CampaignsPanel.tsx"), "utf8");
  check("Campaigns tab asks for manageable seats and renders the picker", /\/api\/agency\/seats\?job=manage/.test(panel) && /manageableSeats\(/.test(panel) && /data-testid="campaigns-seat-picker"/.test(panel));
  check("Campaigns tab names the creator on the list, create, rename, archive, pin and delete", /seatPath\("\/api\/campaigns", seat\.creatorId\)/.test(panel) && /creatorId: seat\.creatorId \} : \{\}\)/.test(panel) && (panel.match(/\.\.\.acting \}/g) ?? []).length === 3 && /seatPath\(url, seat\.creatorId\)/.test(panel));
  check("a seat never gets the creator's spin packs or game editor", /\{!seat && <button/.test(panel) && /showPacks && !seat/.test(panel) && /onOpenGame=\{seat \? undefined : onOpenGame\}/.test(panel));
  const scope = readFileSync(join(root, "src/lib/data/campaigns.ts"), "utf8");
  const writers = scope.slice(scope.indexOf("export async function setCampaignPinnedWheel"));
  check("campaign writers resolve the acting creator and never filter on the caller's id directly", !/user\.id/.test(writers) && (scope.match(/campaignActingSession\(creatorId\)/g) ?? []).length === 6);

  console.log(`campaignSeats.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
