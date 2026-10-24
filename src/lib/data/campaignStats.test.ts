import assert from "node:assert";
import { campaignStatsFor, listCampaignsFor } from "./campaignStats";
import type { CampaignStats } from "./types";
import type { Rarity } from "@/lib/games/wheel/types";

// PERF-3: getCampaignStats used to issue up to 3 queries PER campaign (grants,
// spins, then a fulfilled-redemptions count). The batched version must return
// exactly what the old loop returned, in a fixed number of queries.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

// --- A tiny in-memory PostgREST-ish fake that records every query ------------

type Row = Record<string, unknown>;
type Db = Record<string, Row[]>;

interface FakeOptions {
  /** PostgREST `max_rows`: no response carries more rows than this. */
  maxRows?: number;
}

function fakeClient(db: Db, opts: FakeOptions = {}) {
  const maxRows = opts.maxRows ?? 1000;
  const log: string[] = [];

  function from(table: string) {
    const filters: ((r: Row) => boolean)[] = [];
    const orders: { col: string; asc: boolean }[] = [];
    let columns: string[] = [];
    let embed: { alias: string; table: string; fk: string } | null = null;
    let head = false;
    let countExact = false;
    let range: [number, number] | null = null;

    const valueOf = (r: Row, col: string) => {
      if (!col.includes(".")) return r[col];
      const [alias, inner] = col.split(".");
      return (r[alias] as Row | null)?.[inner];
    };

    const q = {
      select(cols: string, o?: { count?: string; head?: boolean }) {
        head = !!o?.head;
        countExact = o?.count === "exact";
        const m = cols.match(/(\w+):(\w+)!inner\(([^)]*)\)/);
        if (m) {
          // Many-to-one embed joined on `<singular>_id` (spins -> spin_id).
          embed = { alias: m[1], table: m[2], fk: `${m[2].replace(/s$/, "")}_id` };
          cols = cols.replace(m[0], "");
        }
        columns = cols.split(",").map((c) => c.trim()).filter(Boolean);
        return q;
      },
      eq(col: string, val: unknown) {
        filters.push((r) => valueOf(r, col) === val);
        return q;
      },
      in(col: string, vals: unknown[]) {
        filters.push((r) => vals.includes(valueOf(r, col)));
        return q;
      },
      order(col: string, o?: { ascending?: boolean }) {
        orders.push({ col, asc: o?.ascending !== false });
        return q;
      },
      range(a: number, b: number) {
        range = [a, b];
        return q;
      },
      then<T>(resolve: (v: { data: Row[] | null; count: number | null; error: null }) => T) {
        log.push(table);
        let rows = (db[table] ?? []).map((r) => {
          if (!embed) return r;
          const target = (db[embed.table] ?? []).find((t) => t.id === r[embed!.fk]) ?? null;
          return { ...r, [embed.alias]: target };
        });
        if (embed) rows = rows.filter((r) => r[embed!.alias] !== null);
        rows = rows.filter((r) => filters.every((f) => f(r)));
        if (orders.length) {
          rows = [...rows].sort((x, y) => {
            for (const { col, asc } of orders) {
              const a = String(x[col]);
              const b = String(y[col]);
              if (a !== b) return (a < b ? -1 : 1) * (asc ? 1 : -1);
            }
            return 0;
          });
        }
        const count = rows.length;
        if (range) rows = rows.slice(range[0], range[1] + 1);
        rows = rows.slice(0, maxRows);
        const picked = rows.map((r) => {
          const out: Row = {};
          for (const c of columns) out[c] = r[c];
          if (embed) out[embed.alias] = r[embed.alias];
          return out;
        });
        return Promise.resolve(
          resolve({ data: head ? null : picked, count: countExact ? count : null, error: null })
        );
      },
    };
    return q;
  }

  // The real type is the session client; the fake only implements what's used.
  return { client: { from } as unknown as Parameters<typeof campaignStatsFor>[0], log };
}

// --- The pre-PERF-3 implementation, verbatim apart from taking sb/userId -----

type Sb = Parameters<typeof campaignStatsFor>[0];

async function legacyCampaignStats(sb: Sb, userId: string): Promise<CampaignStats[]> {
  const campaigns = await listCampaignsFor(sb, userId);
  return Promise.all(
    campaigns.map(async (campaign) => {
      const [{ data: grantRows }, { data: spinRows }] = await Promise.all([
        sb
          .from("grants")
          .select("fan_id, spins, amount_cents")
          .eq("creator_id", userId)
          .eq("campaign_id", campaign.id),
        sb
          .from("spins")
          .select("id, prize_label, prize_rarity")
          .eq("creator_id", userId)
          .eq("campaign_id", campaign.id),
      ]);
      const grants = (grantRows ?? []) as { fan_id: string; spins: number; amount_cents: number }[];
      const spinsBought = grants.reduce((s, g) => s + g.spins, 0);
      const revenue = grants.reduce((s, g) => s + g.amount_cents, 0);
      const uniqueFans = new Set(grants.map((g) => g.fan_id)).size;
      const spins = (spinRows ?? []) as { id: string; prize_label: string; prize_rarity: Rarity }[];
      const spinsPlayed = spins.length;
      const spinIds = spins.map((s) => s.id);
      let fulfilled = 0;
      if (spinIds.length > 0) {
        const { count } = await sb
          .from("redemptions")
          .select("id", { count: "exact", head: true })
          .eq("status", "fulfilled")
          .in("spin_id", spinIds);
        fulfilled = count ?? 0;
      }
      const counts = new Map<string, { label: string; rarity: Rarity; count: number }>();
      for (const s of spins) {
        const cur = counts.get(s.prize_label);
        if (cur) cur.count += 1;
        else counts.set(s.prize_label, { label: s.prize_label, rarity: s.prize_rarity, count: 1 });
      }
      let topPrize: { label: string; rarity: Rarity; count: number } | null = null;
      for (const entry of counts.values()) {
        if (!topPrize || entry.count > topPrize.count) topPrize = entry;
      }
      const arpu = uniqueFans ? Math.round(revenue / uniqueFans) : 0;
      return {
        campaign,
        spinsBought,
        spinsPlayed,
        uniqueFans,
        fulfilled,
        pending: Math.max(0, spinsPlayed - fulfilled),
        playThroughPct: spinsBought > 0 ? spinsPlayed / spinsBought : 0,
        revenue,
        arpu,
        topPrize,
      };
    })
  );
}

// --- Fixture: 4 campaigns for the creator, plus another creator's rows -------

const ME = "creator-me";
const OTHER = "creator-other";

function fixture(): Db {
  const campaigns: Row[] = [
    { id: "c1", creator_id: ME, name: "Launch", is_active: true, created_at: "2026-01-01T00:00:00Z", pinned_wheel_id: null },
    { id: "c2", creator_id: ME, name: "Summer", is_active: true, created_at: "2026-02-01T00:00:00Z", pinned_wheel_id: "w1" },
    { id: "c3", creator_id: ME, name: "Empty", is_active: false, created_at: "2026-03-01T00:00:00Z", pinned_wheel_id: null },
    { id: "c4", creator_id: ME, name: "Bought, unplayed", is_active: true, created_at: "2026-04-01T00:00:00Z", pinned_wheel_id: null },
    { id: "cx", creator_id: OTHER, name: "Not mine", is_active: true, created_at: "2026-01-15T00:00:00Z", pinned_wheel_id: null },
  ];
  let g = 0;
  const grant = (creator: string, campaign: string | null, fan: string, spins: number, cents: number): Row => ({
    id: `g${String(++g).padStart(3, "0")}`, creator_id: creator, campaign_id: campaign, fan_id: fan, spins, amount_cents: cents,
  });
  const grants: Row[] = [
    grant(ME, "c1", "f1", 10, 1000),
    grant(ME, "c1", "f2", 5, 500),
    grant(ME, "c1", "f1", 3, 333), // repeat fan: uniqueFans 2, arpu rounds
    grant(ME, "c2", "f3", 20, 2500),
    grant(ME, "c4", "f4", 7, 700),
    grant(ME, null, "f5", 9, 900), // uncategorized: not in any campaign
    grant(OTHER, "cx", "f9", 50, 9999),
    grant(OTHER, "c1", "f9", 50, 9999), // other creator's row tagged c1
  ];
  let s = 0;
  const spin = (creator: string, campaign: string | null, label: string, rarity: Rarity): Row => {
    s++;
    return {
      id: `s${String(s).padStart(3, "0")}`, creator_id: creator, campaign_id: campaign,
      prize_label: label, prize_rarity: rarity,
      created_at: `2026-05-01T00:00:${String(s).padStart(2, "0")}Z`,
    };
  };
  const spins: Row[] = [
    spin(ME, "c1", "Sticker", "common"),
    spin(ME, "c1", "Sticker", "common"),
    spin(ME, "c1", "Shoutout", "rare"),
    spin(ME, "c1", "Sticker", "common"),
    spin(ME, "c2", "Video", "epic"),
    spin(ME, "c2", "Photo", "rare"), // tie with Video: first seen wins
    spin(ME, null, "Sticker", "common"),
    spin(OTHER, "cx", "Theirs", "legendary"),
  ];
  let r = 0;
  const red = (spinId: string, creator: string, status: string): Row => ({
    id: `r${String(++r).padStart(3, "0")}`, spin_id: spinId, creator_id: creator, status,
  });
  const redemptions: Row[] = [
    red("s001", ME, "fulfilled"),
    red("s003", ME, "fulfilled"),
    red("s004", ME, "pending"),
    red("s005", ME, "fulfilled"),
    red("s007", ME, "fulfilled"), // uncategorized spin
    red("s008", OTHER, "fulfilled"),
  ];
  return { campaigns, grants, spins, redemptions };
}

async function main() {
  // 1. Same output as the old per-campaign loop, for a multi-campaign fixture.
  const before = fakeClient(fixture());
  const legacy = await legacyCampaignStats(before.client, ME);
  const after = fakeClient(fixture());
  const batched = await campaignStatsFor(after.client, ME);
  assert.deepStrictEqual(batched, legacy);
  check("batched stats deep-equal the legacy per-campaign result", true);

  // Pin the actual numbers too, so both sides can't drift together.
  const byName = Object.fromEntries(batched.map((x) => [x.campaign.name, x]));
  check("campaign order is newest first", batched.map((x) => x.campaign.id).join() === "c4,c3,c2,c1");
  check("only the creator's own campaigns", !batched.some((x) => x.campaign.id === "cx"));
  const c1 = byName["Launch"];
  check("c1 spinsBought 18", c1.spinsBought === 18);
  check("c1 revenue 1833", c1.revenue === 1833);
  check("c1 uniqueFans 2", c1.uniqueFans === 2);
  check("c1 arpu rounds 916.5 -> 917", c1.arpu === 917);
  check("c1 spinsPlayed 4", c1.spinsPlayed === 4);
  check("c1 fulfilled 2 (pending redemption not counted)", c1.fulfilled === 2);
  check("c1 pending 2", c1.pending === 2);
  check("c1 top prize Sticker x3", c1.topPrize?.label === "Sticker" && c1.topPrize.count === 3);
  const c2 = byName["Summer"];
  check("c2 tie goes to the first prize seen", c2.topPrize?.label === "Video" && c2.topPrize.count === 1);
  check("c2 fulfilled 1", c2.fulfilled === 1);
  const c3 = byName["Empty"];
  check("empty campaign is all zeros", c3.spinsBought === 0 && c3.spinsPlayed === 0 && c3.fulfilled === 0 && c3.topPrize === null && c3.playThroughPct === 0 && c3.arpu === 0);
  const c4 = byName["Bought, unplayed"];
  check("bought-but-unplayed campaign", c4.spinsBought === 7 && c4.spinsPlayed === 0 && c4.playThroughPct === 0);

  // 2. Query count: legacy grows with campaigns, batched does not.
  // legacy = 1 campaigns + 2 per campaign + 1 per campaign that has spins.
  check(`legacy issued 1 + 2*4 + 2 = 11 queries (got ${before.log.length})`, before.log.length === 11);
  check(`batched issued 4 queries (got ${after.log.length})`, after.log.length === 4);
  check(
    "batched reads each table once",
    [...after.log].sort().join() === "campaigns,grants,redemptions,spins"
  );

  // 3. Scales: 40 campaigns still take 4 queries.
  const big = fixture();
  for (let i = 0; i < 40; i++) {
    big.campaigns.push({ id: `b${i}`, creator_id: ME, name: `Bulk ${i}`, is_active: true, created_at: `2025-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:${String(i).padStart(2, "0")}Z`, pinned_wheel_id: null });
    big.grants.push({ id: `gb${i}`, creator_id: ME, campaign_id: `b${i}`, fan_id: `fb${i}`, spins: 2, amount_cents: 200 });
    big.spins.push({ id: `sb${i}`, creator_id: ME, campaign_id: `b${i}`, prize_label: "Sticker", prize_rarity: "common", created_at: `2026-06-01T00:00:${String(i).padStart(2, "0")}Z` });
  }
  const bigLegacy = fakeClient(big);
  const bigBatched = fakeClient(big);
  assert.deepStrictEqual(await campaignStatsFor(bigBatched.client, ME), await legacyCampaignStats(bigLegacy.client, ME));
  check("44 campaigns: batched equals legacy", true);
  check(`44 campaigns: batched still 4 queries (got ${bigBatched.log.length})`, bigBatched.log.length === 4);
  check(`44 campaigns: legacy ${bigLegacy.log.length} queries`, bigLegacy.log.length === 1 + 2 * 44 + 42);

  // 4. Batching must not lose rows to the PostgREST row cap: with max_rows=4
  //    and matching pages, every row is still read (via extra pages). The
  //    campaign list itself is one unpaged read, so keep it under the cap.
  const capped = fakeClient(fixture(), { maxRows: 4 });
  const pagedStats = await campaignStatsFor(capped.client, ME, 4);
  assert.deepStrictEqual(pagedStats, legacy);
  check("row cap: paged result still equals the uncapped legacy result", true);
  check(`row cap: grants read in 2 pages (got ${capped.log.filter((t) => t === "grants").length})`, capped.log.filter((t) => t === "grants").length === 2);

  // 5. No campaigns: one query, empty result.
  const none = fakeClient({ campaigns: [], grants: [], spins: [], redemptions: [] });
  const empty = await campaignStatsFor(none.client, ME);
  check("no campaigns -> []", empty.length === 0);
  check("no campaigns -> only the campaigns query", none.log.join() === "campaigns");

  console.log(`campaignStats: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
