import assert from "node:assert/strict";
import { mock } from "node:test";
import { FakeSupabase } from "./fakeSupabase";

// Choosing the game a campaign plays (create, card PATCH, data layer): only
// the creator's own, playable game. Another creator's game id is refused as
// "not found" and nothing is written; archived / draft / bingo games are
// refused as "game_not_playable"; "follow my live game" (null) always works.
const OWNER = "a0000000-0000-4000-8000-000000000001";
const OTHER = "b0000000-0000-4000-8000-000000000002";
const OWN = "c0000000-0000-4000-8000-000000000003";
const OWN_SCRATCH = "c0000000-0000-4000-8000-000000000004";
const FOREIGN = "d0000000-0000-4000-8000-000000000005";
const ARCHIVED = "c0000000-0000-4000-8000-000000000006";
const DRAFT = "c0000000-0000-4000-8000-000000000007";
const BINGO = "c0000000-0000-4000-8000-000000000008";
const db = new FakeSupabase(OWNER);
let useSupabase = true;
mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => useSupabase,
    createClient: async () => db.client(),
    createServiceClient: () => { throw new Error("choosing a campaign game never needs the service role"); },
  },
});

let passed = 0;
const check = (label: string, condition: unknown) => { assert.ok(condition, label); passed++; };

async function main() {
  db.seed("wheels", { id: OWN, creator_id: OWNER, title: "Spin to Win", game_kind: "wheel", game_ready: true, archived_at: null });
  db.seed("wheels", { id: OWN_SCRATCH, creator_id: OWNER, title: "Test Scratch", game_kind: "scratch", game_ready: true, archived_at: null });
  db.seed("wheels", { id: FOREIGN, creator_id: OTHER, title: "Their game", game_kind: "wheel", game_ready: true, archived_at: null });
  db.seed("wheels", { id: ARCHIVED, creator_id: OWNER, title: "Old", game_kind: "wheel", game_ready: true, archived_at: "2026-10-01T00:00:00Z" });
  db.seed("wheels", { id: DRAFT, creator_id: OWNER, title: "Draft", game_kind: "scratch", game_ready: false, archived_at: null });
  db.seed("wheels", { id: BINGO, creator_id: OWNER, title: "Bingo", game_kind: "bingo", game_ready: true, archived_at: null });
  const foreignCampaign = db.seed("campaigns", { creator_id: OTHER, name: "Theirs", is_active: true, pinned_wheel_id: FOREIGN });

  const { createCampaign, setCampaignPinnedWheel } = await import("./campaigns");
  const { PATCH } = await import("../../app/api/campaigns/[id]/route");
  const { POST } = await import("../../app/api/campaigns/route");
  const json = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  // Create with a game.
  const created = await createCampaign("Summer", OWN_SCRATCH);
  check("create with own scratch game", "campaign" in created && created.campaign.pinnedWheelId === OWN_SCRATCH);
  const follow = await createCampaign("Follow", null);
  check("create following the live game", "campaign" in follow && follow.campaign.pinnedWheelId === null);
  let res = await POST(new Request("http://localhost/api/campaigns", json({ name: "Via route", pinnedWheelId: OWN })));
  check("create route accepts own game", res.status === 200 && (await res.json()).campaign.pinnedWheelId === OWN);

  // Cross-tenant refusal (the negative test): nothing written.
  const before = db.rows("campaigns").length;
  const crossCreate = await createCampaign("Steal", FOREIGN);
  check("create cannot point at another creator's game", "error" in crossCreate && crossCreate.error === "not_found" && db.rows("campaigns").length === before);
  res = await POST(new Request("http://localhost/api/campaigns", json({ name: "Steal", pinnedWheelId: FOREIGN })));
  check("create route refuses another creator's game", res.status === 404 && db.rows("campaigns").length === before);
  const campaignId = "campaign" in created ? created.campaign.id : "";
  const patch = (id: string, body: unknown) => PATCH(new Request(`http://localhost/api/campaigns/${id}`, { ...json(body), method: "PATCH" }), { params: Promise.resolve({ id }) });
  res = await patch(String(campaignId), { pinnedWheelId: FOREIGN });
  check("card PATCH cannot pin another creator's game", res.status === 404 && db.row("campaigns", String(campaignId)).pinned_wheel_id === OWN_SCRATCH);
  const crossSet = await setCampaignPinnedWheel(String(campaignId), FOREIGN);
  check("data layer cannot pin another creator's game", "error" in crossSet && crossSet.error === "not_found" && db.row("campaigns", String(campaignId)).pinned_wheel_id === OWN_SCRATCH);
  res = await patch(String(foreignCampaign.id), { pinnedWheelId: OWN });
  check("cannot change another creator's campaign", res.status === 404 && db.row("campaigns", String(foreignCampaign.id)).pinned_wheel_id === FOREIGN);

  // Unplayable games are refused, not silently ignored later by the resolver.
  for (const [label, id] of [["archived", ARCHIVED], ["draft", DRAFT], ["bingo", BINGO]] as const) {
    res = await patch(String(campaignId), { pinnedWheelId: id });
    check(`${label} game refused on the card`, res.status === 400 && (await res.json()).error === "game_not_playable" && db.row("campaigns", String(campaignId)).pinned_wheel_id === OWN_SCRATCH);
    const made = await createCampaign(`With ${label}`, id);
    check(`${label} game refused on create`, "error" in made && made.error === "game_not_playable");
  }
  res = await patch(String(campaignId), { pinnedWheelId: 42 });
  check("non-string game id is a bad request", res.status === 400);

  // Changing and clearing your own campaign's game.
  res = await patch(String(campaignId), { pinnedWheelId: OWN });
  check("change to own wheel", res.status === 200 && db.row("campaigns", String(campaignId)).pinned_wheel_id === OWN);
  res = await patch(String(campaignId), { pinnedWheelId: null });
  check("follow my live game again", res.status === 200 && db.row("campaigns", String(campaignId)).pinned_wheel_id === null);

  // Demo store follows the same rules.
  useSupabase = false;
  const { mockListWheels } = await import("./mock");
  const demoGames = mockListWheels(true);
  const demoGame = demoGames.find((w) => !w.archivedAt && w.gameReady !== false && w.gameKind !== "bingo");
  assert.ok(demoGame, "demo store has a playable game");
  const demo = await createCampaign("Demo", demoGame.id);
  check("demo create with game", "campaign" in demo && demo.campaign.pinnedWheelId === demoGame.id);
  const demoMissing = await createCampaign("Demo missing", "no-such-game");
  check("demo refuses unknown game", "error" in demoMissing && demoMissing.error === "not_found");
  console.log(`campaign game choice: ${passed} checks passed`);
}
main().catch((error) => { console.error(error); process.exit(1); });
