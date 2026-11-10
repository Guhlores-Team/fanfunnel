import assert from "node:assert/strict";
import { mock } from "node:test";
import { FakeSupabase, type Row } from "./fakeSupabase";

// 0073 (DB-11 / DB-12): a save carries the game version the editor loaded;
// a save over a newer version is refused with game_changed (409) instead of
// silently replacing another tab's or a team member's edits. An unfinished,
// never-published bingo game is stored as an inactive draft (WC-11).

let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };

const owner = "00000000-0000-0000-0000-000000000073";
const db = new FakeSupabase(owner);
db.tables.profiles = []; db.tables.prizes = []; db.tables.spins = [];
db.seed("profiles", { id: owner, features: { bingo: true, scratch: true } });
// The fake compares timestamps as strings, so the fixture uses the ISO form
// (PostgreSQL compares them as instants; the app sends a one-millisecond window).
const V1 = "2026-11-10T10:00:00.123Z";
const wheelRow = db.seed("wheels", { creator_id: owner, title: "Before", game_kind: "wheel", game_config: {}, game_ready: true, brand_color: "#ec4899", updated_at: V1, prizes: [] });
const rpcs: { name: string; args: Row }[] = [];
let rpcError: { code: string; message: string } | null = null;
const service = () => ({
  ...db.client(),
  rpc: async (name: string, args: unknown) => {
    if (name !== "save_wheel_prizes" && name !== "save_game_wheel") return db.client().rpc(name, args);
    rpcs.push({ name, args: structuredClone(args as Row) });
    if (rpcError) return { data: null, error: rpcError };
    const input = args as Row;
    const target = db.row("wheels", String(input.p_wheel));
    if (name === "save_game_wheel") Object.assign(target, input.p_config as Row, { game_ready: input.p_ready !== false });
    target.prizes = (input.p_prizes as Row[]).map((prize) => ({ ...prize, id: prize.id ?? crypto.randomUUID(), delivery: "manual" }));
    return { data: null, error: null };
  },
});
let useSupabase = true;
mock.module("@/lib/supabase/server", { namedExports: { isSupabaseConfigured: () => useSupabase, createClient: async () => db.client(), createServiceClient: service } });
mock.module("next/cache", { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } });

async function main() {
  const { getWheelById, saveWheel, createWheel, wheelSettingsChanged } = await import("./wheels");
  const prizes = [
    { id: "t1", label: "One", rarity: "common" as const, weight: 5, stock: null },
    { id: "t2", label: "Two", rarity: "rare" as const, weight: 1, stock: null },
  ];

  // --- Supabase path ---------------------------------------------------------
  const loaded = (await getWheelById(String(wheelRow.id)))!;
  check("the creator's read carries the game version", loaded.updatedAt === V1);

  const stale = await saveWheel({ ...loaded, title: "Mine", prizes }, { expectedUpdatedAt: "2026-11-10T09:00:00.000Z" });
  check("a save over a newer version is game_changed and writes nothing", "error" in stale && stale.error === "game_changed" && db.row("wheels", String(wheelRow.id)).title === "Before" && rpcs.length === 0);

  const sameSettings = await saveWheel({ ...loaded, prizes }, { expectedUpdatedAt: V1 });
  assert.ok("wheel" in sameSettings, JSON.stringify(sameSettings));
  check("a prize-only save leaves the settings version alone and hands it to save_wheel_prizes", db.row("wheels", String(wheelRow.id)).updated_at === V1 && rpcs.at(-1)?.name === "save_wheel_prizes" && rpcs.at(-1)?.args.p_expected_updated_at === V1);

  const renamed = await saveWheel({ ...loaded, title: "After", prizes }, { expectedUpdatedAt: V1 });
  assert.ok("wheel" in renamed, JSON.stringify(renamed));
  const stamped = String(db.row("wheels", String(wheelRow.id)).updated_at);
  check("changed settings advance the version in the same compare-and-set update", stamped !== V1 && db.row("wheels", String(wheelRow.id)).title === "After");
  check("save_wheel_prizes then expects the version that update produced", rpcs.at(-1)?.args.p_expected_updated_at === stamped);
  const secondTab = await saveWheel({ ...loaded, title: "Other tab", prizes }, { expectedUpdatedAt: V1 });
  check("the second tab (still on the old version) is refused", "error" in secondTab && secondTab.error === "game_changed" && db.row("wheels", String(wheelRow.id)).title === "After");

  const before = rpcs.length;
  const legacy = await saveWheel({ ...loaded, title: "No version", prizes });
  check("a save without a version (an older tab) still saves, unchecked", "wheel" in legacy && rpcs.length === before + 1 && rpcs.at(-1)?.args.p_expected_updated_at === null);

  rpcError = { code: "22023", message: "game_changed" };
  const raced = await saveWheel({ ...loaded, title: "No version", prizes }, { expectedUpdatedAt: String(db.row("wheels", String(wheelRow.id)).updated_at) });
  check("game_changed raised by SQL crosses the boundary as itself", "error" in raced && raced.error === "game_changed");
  rpcError = null;

  // --- bingo draft (p_ready) --------------------------------------------------
  const draft = (await createWheel({ gameKind: "bingo" })).wheel;
  const nine = Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, label: `Cell ${i}`, rarity: "common" as const, weight: 1, stock: null }));
  const unfinished = { ...draft, title: "Half-built bingo", prizes: nine, gameConfig: { size: 3 as const, linePrizeId: null } };
  const refused = await saveWheel(unfinished);
  check("without the draft flag an unfinished bingo game is still refused", "error" in refused);
  const savedDraft = await saveWheel(unfinished, { draft: true, expectedUpdatedAt: draft.updatedAt ?? null });
  assert.ok("wheel" in savedDraft, JSON.stringify(savedDraft));
  const draftCall = rpcs.at(-1)!;
  check("the draft goes through save_game_wheel with p_ready=false and no line prize", draftCall.name === "save_game_wheel" && draftCall.args.p_ready === false && ((draftCall.args.p_config as Row).game_config as Row).linePrizeId === null);
  check("a saved draft stays unpublished", savedDraft.wheel.gameReady === false);
  const complete = { ...unfinished, prizes: nine.map((p, i) => (i === 0 ? { ...p, rarity: "rare" as const } : p)), gameConfig: { size: 3 as const, linePrizeId: "c0" } };
  const published = await saveWheel({ ...complete, id: draft.id }, { draft: true });
  check("a complete game publishes even when the draft flag is sent", "wheel" in published && rpcs.at(-1)?.args.p_ready === true && published.wheel.gameReady === true);
  const broken = await saveWheel({ ...complete, id: draft.id, prizes: nine.slice(0, 8), gameConfig: { size: 3 as const, linePrizeId: "c1" } }, { draft: true });
  check("a published game can never be un-published through the draft flag", "error" in broken && db.row("wheels", draft.id).game_ready === true);

  check("unchanged settings are not a change; a new title or a sent schedule is",
    !wheelSettingsChanged({ id: "w", title: "T", prizes: [], brandColor: "#ec4899", gameKind: "wheel", gameConfig: {} }, { game_kind: "wheel", game_config: {}, title: "T", subtitle: null, brand_color: "#ec4899", label_color: null, label_size: null }) &&
    wheelSettingsChanged({ id: "w", title: "T", prizes: [] }, { game_kind: "wheel", game_config: {}, title: "U", subtitle: null, brand_color: "#ec4899", label_color: null, label_size: null }) &&
    wheelSettingsChanged({ id: "w", title: "T", prizes: [] }, { game_kind: "wheel", game_config: {}, title: "T", subtitle: null, brand_color: "#ec4899", label_color: null, label_size: null, active_from: null }));

  // --- demo path + route ------------------------------------------------------
  useSupabase = false;
  const m = await import("./mock");
  const route = await import("@/app/api/wheel/route");
  const put = (body: unknown) => route.PUT(new Request("http://localhost/api/wheel", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  const demo = m.mockCreateWheel({ name: "Versioned" }).wheel;
  const first = { ...m.mockGetWheelById(demo.id)!, prizes };
  check("the demo read carries a version too", typeof first.updatedAt === "string");
  const stock = {};
  await new Promise((r) => setTimeout(r, 5));
  let res = await put({ wheel: { ...first, title: "Tab one" }, expectedStock: stock, expectedUpdatedAt: first.updatedAt });
  const one = (await res.json()) as { wheel?: { updatedAt?: string; title: string }; error?: string };
  check("the first tab saves and gets the new version back", res.status === 200 && one.wheel?.title === "Tab one" && one.wheel.updatedAt !== first.updatedAt);
  res = await put({ wheel: { ...first, title: "Tab two" }, expectedStock: stock, expectedUpdatedAt: first.updatedAt });
  check("the second tab is answered 409 game_changed", res.status === 409 && ((await res.json()) as { error: string }).error === "game_changed" && m.mockGetWheelById(demo.id)!.title === "Tab one");
  check("the stored game never keeps a client-sent version", !Object.hasOwn(m.mockGetWheelById(demo.id)!, "updatedAt") || m.mockGetWheelById(demo.id)!.updatedAt === one.wheel?.updatedAt);
  check("an unparsable version is a 400", (await put({ wheel: first, expectedStock: stock, expectedUpdatedAt: "yesterday" })).status === 400);
  check("a non-boolean draft flag is a 400", (await put({ wheel: first, expectedStock: stock, draft: "yes" })).status === 400);

  const demoDraft = m.mockCreateWheel({ name: "Demo bingo", gameKind: "bingo", gameConfig: { size: 3, linePrizeId: null } }).wheel;
  const demoNine = nine.map((p) => ({ ...p, id: `d-${p.id}` }));
  res = await put({ wheel: { ...demoDraft, prizes: demoNine }, expectedStock: {} });
  check("demo: an unfinished bingo game without the draft flag is refused", res.status >= 400);
  res = await put({ wheel: { ...demoDraft, prizes: demoNine }, expectedStock: {}, draft: true });
  const kept = (await res.json()) as { wheel?: { gameReady?: boolean; prizes: unknown[] } };
  check("demo: with the flag it is stored as an inactive draft", res.status === 200 && kept.wheel?.gameReady === false && kept.wheel.prizes.length === 9 && m.mockListWheels().find((w) => w.id === demoDraft.id)?.isActive !== true);

  console.log(`wheelVersion.test: ${passed} checks passed`);
}
main().catch((error) => { console.error(error); process.exit(1); });
