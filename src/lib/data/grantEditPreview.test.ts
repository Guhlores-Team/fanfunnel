import assert from "node:assert";
import { mock } from "node:test";
import { FakeSupabase, type Row } from "./fakeSupabase";
import { grantImpact } from "../../components/dashboard/grantImpact";
import type { FanDetail } from "./types";
import {
  mockAckFan,
  mockCreatePass,
  mockCreateWheel,
  mockEditGrant,
  mockGetFanDetail,
  mockListFans,
  mockSpin,
} from "./mock";

// Owner decision h: the fan drawer's grant-edit preview is exact per wheel.
// getFanDetail returns, for each grant, the balance of the pass editGrant
// would actually move (the grant's own pass while active, else the fan's
// oldest active pass). These checks drive the drawer's preview (grantImpact)
// from getFanDetail, then run editGrant, and require the two to agree: a
// refused preview is a refused edit, and an allowed one lands the pass on
// exactly the balance the preview showed. Both data paths (Supabase + mock).

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const CREATOR = "creator-1";
const db = new FakeSupabase(CREATOR);

mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => true,
    createClient: async () => db.client(),
    createServiceClient: () => db.client(),
  },
});

/** The drawer's preview for an edit, exactly as GrantRow builds it. */
function preview(detail: FanDetail, grantId: string, spinsInput: string) {
  const g = detail.grants.find((x) => x.id === grantId);
  assert.ok(g, `grant ${grantId} in detail`);
  return grantImpact({
    grantSpins: g.spins,
    spinsInput,
    fanSpinsRemaining: detail.spinsRemaining,
    passSpinsRemaining: g.editPass ? g.editPass.spinsRemaining : null,
    wheelTitle: g.editPass?.wheelTitle ?? null,
  });
}

function invariantHolds(fanId: string): boolean {
  const fan = db.row("fans", fanId);
  return (
    fan.spins_remaining === db.sumPasses(fanId, "spins_remaining") &&
    fan.spins_granted_total === db.sumPasses(fanId, "spins_granted_total")
  );
}

async function main() {
  const { editGrant, getFanDetail } = await import("./index");
  const wheelA = db.seed("wheels", { creator_id: CREATOR, is_active: true, title: "Wheel A" });
  const wheelB = db.seed("wheels", { creator_id: CREATOR, title: "Wheel B" });

  const balances = (fanId: string) =>
    new Map(
      db
        .rows("fan_passes")
        .filter((p) => p.fan_id === fanId)
        .map((p) => [p.id as string, p.spins_remaining as number])
    );

  /**
   * Preview an edit from getFanDetail, run editGrant, and require they agree.
   * Returns the preview so a case can assert on its wording too.
   */
  async function previewThenEdit(label: string, fanId: string, grantId: string, spins: number) {
    const detail = await getFanDetail(fanId);
    assert.ok(detail, `${label}: fan detail`);
    const impact = preview(detail, grantId, String(spins));
    const before = balances(fanId);
    const res = await editGrant(grantId, { spins });
    const after = balances(fanId);
    const moved = [...after].filter(([id, v]) => before.get(id) !== v);
    check(
      `${label}: preview allowed=${impact.allowed} matches editGrant ${JSON.stringify(res)}`,
      impact.allowed === "ok" in res
    );
    if ("ok" in res && impact.delta !== 0) {
      check(`${label}: exactly one pass moved (${moved.length})`, moved.length === 1);
      const [passId, now] = moved[0];
      const g = detail.grants.find((x) => x.id === grantId)!;
      check(
        `${label}: the moved pass started at the previewed balance (${before.get(passId)} vs ${g.editPass?.spinsRemaining})`,
        before.get(passId) === g.editPass?.spinsRemaining
      );
      check(`${label}: the pass ends where the preview said (${now} vs ${impact.remainingAfter})`, now === impact.remainingAfter);
    } else {
      check(`${label}: no pass moved`, moved.length === 0);
    }
    check(`${label}: fans == SUM(passes)`, invariantHolds(fanId));
    return { impact, res, detail };
  }

  // --- Supabase path -----------------------------------------------------------
  // Fan on two wheels: wheel A got a 5-spin grant and spun 3 of it (2 left);
  // wheel B has an untouched 4-spin grant. Fan total 6. (The fake doesn't
  // resolve embeds, so each pass row carries its `wheel:wheels(title)` embed.)
  const fan = db.seed("fans", { creator_id: CREATOR, display_name: "TwoWheels" });
  const fanId = fan.id as string;
  const passA = db.seed("fan_passes", {
    token: "tok-a",
    creator_id: CREATOR,
    wheel_id: wheelA.id,
    fan_id: fanId,
    spins_remaining: 2,
    spins_granted_total: 5,
    wheel: { title: "Wheel A" },
  });
  const passB = db.seed("fan_passes", {
    token: "tok-b",
    creator_id: CREATOR,
    wheel_id: wheelB.id,
    fan_id: fanId,
    spins_remaining: 4,
    spins_granted_total: 4,
    wheel: { title: "Wheel B" },
  });
  const grantA = db.seed("grants", { creator_id: CREATOR, fan_id: fanId, fan_pass_id: passA.id, spins: 5, amount_cents: 500 });
  const grantB = db.seed("grants", { creator_id: CREATOR, fan_id: fanId, fan_pass_id: passB.id, spins: 4, amount_cents: 400 });
  const orphan = db.seed("grants", { creator_id: CREATOR, fan_id: fanId, fan_pass_id: null, spins: 2, amount_cents: 0 });

  const d0 = await getFanDetail(fanId);
  assert.ok(d0, "supabase fan detail");
  const gA = (r: Row) => d0.grants.find((g) => g.id === r.id);
  check("setup: fan total is 6", d0.spinsRemaining === 6);
  check("getFanDetail: grant A's edit pass is pass A (2 left)", gA(grantA)?.editPass?.spinsRemaining === 2);
  check("getFanDetail: grant A's wheel is named", gA(grantA)?.editPass?.wheelTitle === "Wheel A");
  check("getFanDetail: grant B's edit pass is pass B (4 left)", gA(grantB)?.editPass?.spinsRemaining === 4);
  check("getFanDetail: an orphan grant previews the oldest active pass (A)", gA(orphan)?.editPass?.spinsRemaining === 2);
  check("getFanDetail: links still listed newest first", d0.links.map((l) => l.token).join() === "tok-b,tok-a");

  // 1. The case the fan-level preview got wrong: cutting grant A 5 -> 1 needs 4
  //    back from pass A, which has 2. Fan total (6) would have said "fine".
  check(
    "fan-level preview would have allowed the cut",
    grantImpact({ grantSpins: 5, spinsInput: "1", fanSpinsRemaining: d0.spinsRemaining }).allowed
  );
  const cut = await previewThenEdit("A 5->1", fanId, grantA.id as string, 1);
  check("A 5->1: refused as insufficient_spins", "error" in cut.res && cut.res.error === "insufficient_spins");
  check("A 5->1: grant untouched", db.row("grants", grantA.id as string).spins === 5);

  // 2. Deepest allowed cut on A, and a cut on B: each lands where the preview said.
  await previewThenEdit("A 5->3", fanId, grantA.id as string, 3);
  await previewThenEdit("B 4->0", fanId, grantB.id as string, 0);
  check("B 4->0: pass A untouched by B's edit", db.row("fan_passes", passA.id as string).spins_remaining === 0);

  // 3. Grow, and the orphan grant (oldest active pass).
  await previewThenEdit("A 3->6", fanId, grantA.id as string, 6);
  await previewThenEdit("orphan 2->5", fanId, orphan.id as string, 5);
  check("orphan 2->5: landed on pass A (3 + 3 = 6)", db.row("fan_passes", passA.id as string).spins_remaining === 6);

  // 4. The grant's own pass was deactivated: the edit moves via the fan's
  //    oldest ACTIVE pass, and the preview follows it.
  db.row("fan_passes", passA.id as string).is_active = false;
  db.row("fans", fanId).spins_remaining = db.sumPasses(fanId);
  db.row("fans", fanId).spins_granted_total = db.sumPasses(fanId, "spins_granted_total");
  const d1 = await getFanDetail(fanId);
  assert.ok(d1, "detail after deactivation");
  check(
    "inactive own pass: preview uses pass B (0 left)",
    d1.grants.find((g) => g.id === grantA.id)?.editPass?.spinsRemaining === 0 &&
      d1.grants.find((g) => g.id === grantA.id)?.editPass?.wheelTitle === "Wheel B"
  );
  await previewThenEdit("A via B 6->5 (B has 0)", fanId, grantA.id as string, 5);
  await previewThenEdit("A via B 6->8", fanId, grantA.id as string, 8);
  check("A via B: pass B got the +2", db.row("fan_passes", passB.id as string).spins_remaining === 2);

  // 5. No active pass at all: editGrant refuses any spin change
  //    (no_active_pass) and getFanDetail says there is no pass to preview.
  db.row("fan_passes", passB.id as string).is_active = false;
  db.row("fans", fanId).spins_remaining = 0;
  db.row("fans", fanId).spins_granted_total = 0;
  const d2 = await getFanDetail(fanId);
  assert.ok(d2, "detail with no active pass");
  check("no active pass: every grant's editPass is null", d2.grants.every((g) => g.editPass === null));
  const none = await previewThenEdit("no pass 8->9", fanId, grantA.id as string, 9);
  check("no pass: editGrant says no_active_pass", "error" in none.res && none.res.error === "no_active_pass");
  const keep = await previewThenEdit("no pass, spins unchanged", fanId, grantA.id as string, 8);
  check("no pass: an unchanged-spins save is still allowed", "ok" in keep.res);

  // 6. Two passes created in the same instant: the tie-break (id) picks the
  //    same "oldest" pass in getFanDetail and editGrant.
  const tie = db.seed("fans", { creator_id: CREATOR, display_name: "Tie" });
  const tieId = tie.id as string;
  const at = "2026-02-01T00:00:00.000Z";
  db.seed("fan_passes", { id: "fan_passes-tie-b", token: "tok-tb", creator_id: CREATOR, wheel_id: wheelB.id, fan_id: tieId, spins_remaining: 7, spins_granted_total: 7, created_at: at });
  db.seed("fan_passes", { id: "fan_passes-tie-a", token: "tok-ta", creator_id: CREATOR, wheel_id: wheelA.id, fan_id: tieId, spins_remaining: 1, spins_granted_total: 1, created_at: at });
  const tieGrant = db.seed("grants", { creator_id: CREATOR, fan_id: tieId, fan_pass_id: null, spins: 1, amount_cents: 0 });
  const dt = await getFanDetail(tieId);
  check("tie: preview picks the lower id (1 left)", dt?.grants[0]?.editPass?.spinsRemaining === 1);
  await previewThenEdit("tie 1->0", tieId, tieGrant.id as string, 0);
  check("tie: editGrant moved the same pass", db.row("fan_passes", "fan_passes-tie-a").spins_remaining === 0);

  // --- Mock path: same agreement ---------------------------------------------
  const m = mockCreatePass("MockTwoWheels", 5, undefined, undefined, 500);
  mockAckFan(m.token);
  for (let i = 0; i < 3; i++) {
    const r = await mockSpin(m.token);
    assert.ok(r && !("error" in r), "mock spin succeeded");
  }
  const second = mockCreateWheel({ name: "Mock Wheel B" }).wheel;
  mockCreatePass("MockTwoWheels", 4, m.fanId, undefined, 400, 0, undefined, undefined, second.id);

  const mockPasses = () => mockListFans().find((f) => f.fanId === m.fanId)!.passes;
  const mockBalances = () => new Map(mockPasses().map((p) => [p.token, p.spinsRemaining]));
  function mockPreviewThenEdit(label: string, grantId: string, spins: number) {
    const detail = mockGetFanDetail(m.fanId);
    assert.ok(detail, `${label}: mock fan detail`);
    const impact = preview(detail, grantId, String(spins));
    const before = mockBalances();
    const res = mockEditGrant(grantId, { spins });
    const after = mockBalances();
    const moved = [...after].filter(([t, v]) => before.get(t) !== v);
    check(`${label}: mock preview allowed=${impact.allowed} matches ${JSON.stringify(res)}`, impact.allowed === "ok" in res);
    if ("ok" in res && impact.delta !== 0) {
      check(`${label}: one mock pass moved`, moved.length === 1);
      check(`${label}: mock pass ends where the preview said`, moved[0][1] === impact.remainingAfter);
    } else {
      check(`${label}: no mock pass moved`, moved.length === 0);
    }
    const fanRow = mockListFans().find((f) => f.fanId === m.fanId)!;
    check(`${label}: mock fans == SUM(passes)`, fanRow.spinsRemaining === fanRow.passes.reduce((s, p) => s + p.spinsRemaining, 0));
    return { impact, res };
  }

  const md = mockGetFanDetail(m.fanId);
  assert.ok(md, "mock detail");
  check("mock setup: fan total 2 + 4 = 6", md.spinsRemaining === 6);
  const [mGrantB, mGrantA] = md.grants; // newest first
  check("mock getFanDetail: grant A's pass has 2 left", mGrantA.editPass?.spinsRemaining === 2);
  check("mock getFanDetail: grant B's pass has 4 left on Mock Wheel B", mGrantB.editPass?.spinsRemaining === 4 && mGrantB.editPass?.wheelTitle === "Mock Wheel B");

  const mCut = mockPreviewThenEdit("mock A 5->1", mGrantA.id, 1);
  check("mock A 5->1: refused as insufficient_spins", "error" in mCut.res && mCut.res.error === "insufficient_spins");
  const mB = mockPreviewThenEdit("mock B 4->1", mGrantB.id, 1);
  check(
    "mock B 4->1: preview names the wheel",
    mB.impact.message === "This fan has 4 spins left on Mock Wheel B. Setting it to 1 takes back 3 spins and leaves 1 spin on Mock Wheel B."
  );
  mockPreviewThenEdit("mock A 5->3", mGrantA.id, 3);
  mockPreviewThenEdit("mock A 3->7", mGrantA.id, 7);

  console.log(`grantEditPreview.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
