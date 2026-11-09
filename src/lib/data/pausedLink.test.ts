import assert from "node:assert";
import { mock } from "node:test";
import { randomBytes } from "node:crypto";

// T3: a paused link is permanent but keeps a read-only "Your wins" view.
//   - only a paused link gets it (a live, unknown or deleted link does not);
//   - each win carries its prize, date and delivery state (T5);
//   - an instant reward's value appears only once the fan already revealed it
//     (views >= 1), never for a blocked fan, and never after it was erased;
//   - nothing is written: no reward view is counted and no spin is possible.
//   Demo path through the real mock store; Supabase path with a scripted client.

process.env.REWARD_ENCRYPTION_KEY = randomBytes(32).toString("base64");

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const writes: string[] = [];
let PASS: Record<string, unknown> | null = null;
let SPINS: Record<string, unknown>[] = [];
function fakeService() {
  return {
    from(table: string) {
      const result = () => {
        if (table === "fan_passes") return { data: PASS, error: null };
        if (table === "spins") return { data: SPINS, error: null };
        return { data: null, error: null };
      };
      const proxy: unknown = new Proxy({}, {
        get(_t, prop: string) {
          if (prop === "then") return (ok: (v: unknown) => unknown) => Promise.resolve(result()).then(ok);
          if (prop === "maybeSingle" || prop === "single") return () => Promise.resolve(result());
          if (["insert", "update", "upsert", "delete"].includes(prop)) return () => { writes.push(`${table}.${prop}`); return proxy; };
          return () => proxy;
        },
      });
      return proxy;
    },
    rpc: async (name: string) => { writes.push(`rpc.${name}`); return { data: null, error: null }; },
  };
}

let useSupabase = false;
mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => useSupabase,
    createClient: async () => fakeService(),
    createServiceClient: () => fakeService(),
  },
});

async function main() {
  const { getPausedFanWins } = await import("./pausedLink");
  const m = await import("./mock");
  const { setRedemptionStatus } = await import("./fulfilment");
  const { sealReward } = await import("@/lib/rewards/crypto");

  // --- demo path -----------------------------------------------------------------
  const original = m.mockGetWheel();
  m.mockSaveWheel({ ...original, prizes: [
    { id: "pz-link", label: "VIP link", rarity: "rare", weight: 1, stock: null },
    { id: "pz-plain", label: "Shout-out", rarity: "common", weight: 0, stock: null },
  ] });
  m.mockSetPrizeDelivery("pz-link", "link", "https://example.com/vip");
  const fan = m.mockCreatePass("Paused Pia", 3);
  m.mockAckFan(fan.token);
  check("demo: a live link has no paused view", (await getPausedFanWins(fan.token)) === null);
  const won = await m.mockSpin(fan.token, "seed");
  check("demo: the fan won the instant link", !("error" in won) && won.reward?.value === "https://example.com/vip");
  const shareId = !("error" in won) ? won.shareId : "";
  m.mockSaveWheel({ ...m.mockGetWheel(), prizes: m.mockGetWheel().prizes.map((p) => ({ ...p, weight: p.id === "pz-plain" ? 1 : 0 })) });
  const manual = await m.mockSpin(fan.token, "seed2");
  const manualShare = !("error" in manual) ? manual.shareId : "";
  const pending = m.mockGetOverview().redemptions.find((r) => r.prizeLabel === "Shout-out" && r.fanName === "Paused Pia");
  check("demo: the manual win waits in Fulfilment", pending?.status === "pending");

  // T5: the live fan page carries the same delivery state on each win.
  const live = await m.mockGetFanPass(fan.token);
  check("demo (T5): the live page shows the manual win as waiting", live?.recentWins.find((w) => w.shareId === manualShare)?.delivery?.status === "waiting");
  check("demo (T5): the live page shows the instant win as delivered", live?.recentWins.find((w) => w.shareId === shareId)?.delivery?.status === "delivered");

  m.mockSelfExclude(fan.token);
  const view = await getPausedFanWins(fan.token);
  check("demo: a paused link gets the read-only view", !!view && view.wins.length === 2);
  const linkWin = view!.wins.find((w) => w.shareId === shareId)!;
  const manualWin = view!.wins.find((w) => w.shareId === manualShare)!;
  check("demo: the already-revealed link is kept for the fan", linkWin.reward?.value === "https://example.com/vip" && !linkWin.rewardHidden);
  check("demo: an instant win reads as delivered", linkWin.delivery?.status === "delivered");
  check("demo: the manual win reads as waiting, with no reward", manualWin.delivery?.status === "waiting" && manualWin.reward === null && !manualWin.rewardHidden);
  check("demo: the paused view says when it was paused", typeof view!.pausedAt === "string" && view!.pausedAt.length > 0);
  check("demo: the paused link still cannot spin", "error" in (await m.mockSpin(fan.token, "seed3")));
  await setRedemptionStatus(pending!.id, "fulfilled");
  const after = await getPausedFanWins(fan.token);
  const delivered = after!.wins.find((w) => w.shareId === manualShare)!;
  check("demo: a later delivery shows with its time", delivered.delivery?.status === "delivered" && !!delivered.delivery.at);

  // T9: the export carries each prize's delivery words and the creator's messages.
  await (await import("./index")).sendCreatorMessage(fan.fanId, "your prize is on its way");
  const exported = m.mockExportFanData(fan.token)!;
  check("demo (T9): exported prizes say how delivery stands", exported.prizes.some((p) => p.prize === "Shout-out" && p.status === "fulfilled" && /^Delivered /.test(p.delivery ?? "") && !!p.fulfilledAt));
  check("demo (T9): the creator's messages are exported as received", exported.messagesYouReceived.some((msg) => msg.body === "your prize is on its way"));

  m.mockSetFanBlocked(fan.fanId, true);
  const blocked = await getPausedFanWins(fan.token);
  const blockedLink = blocked!.wins.find((w) => w.shareId === shareId)!;
  check("demo: a blocked fan's paused view never shows a value", blockedLink.reward === null && blockedLink.rewardHidden);
  m.mockSetFanBlocked(fan.fanId, false);
  check("demo: an unknown token has no paused view", (await getPausedFanWins("not-a-real-token")) === null);
  check("demo: a malformed token is refused before any read", (await getPausedFanWins("../../x")) === null);
  m.mockSaveWheel(original);

  // --- Supabase path -----------------------------------------------------------------
  useSupabase = true;
  const creator = "c1";
  const sealed = sealReward("CODE-1234", creator);
  const now = new Date().toISOString();
  const rewardRow = (views: number, erased: string | null = null) => ({ kind: "code", cipher: sealed.cipher, iv: sealed.iv, key_version: sealed.keyVersion, views, erased_at: erased, created_at: now });
  const fanRow = { blocked_at: null as string | null, leaderboard_opt_in: true };
  PASS = { fan_id: "f1", creator_id: creator, self_excluded_at: null, fan: fanRow, creator: { display_name: "Creator One" } };
  SPINS = [
    { id: "s1", prize_label: "Seen code", prize_rarity: "epic", share_id: "sh1", created_at: now, redemption: { status: "fulfilled", fulfilled_at: now }, reward: rewardRow(1) },
    { id: "s2", prize_label: "Unseen code", prize_rarity: "rare", share_id: "sh2", created_at: now, redemption: [{ status: "fulfilled", fulfilled_at: now }], reward: [rewardRow(0)] },
    { id: "s3", prize_label: "Erased code", prize_rarity: "rare", share_id: "sh3", created_at: now, redemption: null, reward: rewardRow(2, now) },
    { id: "s4", prize_label: "Signed photo", prize_rarity: "common", share_id: "sh4", created_at: now, redemption: { status: "in_progress", fulfilled_at: null }, reward: null },
  ];
  check("supabase: a live link has no paused view", (await getPausedFanWins("tok-live")) === null);
  PASS = { ...PASS, self_excluded_at: now };
  writes.length = 0;
  const sv = await getPausedFanWins("tok-paused");
  check("supabase: a paused link gets the view, creator named", !!sv && sv.creatorTitle === "Creator One" && sv.wins.length === 4 && sv.leaderboardOptIn);
  const [seen, unseen, erased, photo] = sv!.wins;
  check("supabase: a revealed code is shown", seen.reward?.value === "CODE-1234" && seen.reward.kind === "code");
  check("supabase: a never-revealed code stays hidden", unseen.reward === null && unseen.rewardHidden);
  check("supabase: an erased code is never shown", erased.reward === null && erased.rewardHidden);
  check("supabase: delivery states come through (array or object embeds)", seen.delivery?.status === "delivered" && unseen.delivery?.status === "delivered" && photo.delivery?.status === "in_progress" && erased.delivery === undefined);
  check("supabase: nothing written, no reward view counted", writes.length === 0);
  PASS = { ...PASS, fan: { ...fanRow, blocked_at: now } };
  const sb = await getPausedFanWins("tok-paused");
  check("supabase: a blocked fan sees no values", sb!.wins.every((w) => w.reward === null));
  PASS = null;
  check("supabase: an unknown token has no paused view", (await getPausedFanWins("tok-unknown")) === null);

  console.log(`pausedLink.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
