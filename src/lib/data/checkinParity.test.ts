import assert from "node:assert";
import { mock } from "node:test";

// RM-3: the Supabase check-in path (recordCheckin, readFanGlow, the creator
// reads) and the demo mock store must give the same glow, the same milestones
// on the same days, and the same creator counts, over a long visit history
// with gaps. Also pins that the glow never moves a balance on either path.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {
  fans: [{ id: "fan-1", creator_id: "creator-a", blocked_at: null, spins_remaining: 3 }],
  fan_passes: [{ token: "tok-1", fan_id: "fan-1", creator_id: "creator-a", is_active: true, self_excluded_at: null, spins_remaining: 3 }],
  fan_checkins: [],
};
let configured = true;

function from(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  let cols = "";
  let upsertRow: Row | null = null;
  let limit = Infinity;
  let range: [number, number] | null = null;
  const exec = () => {
    if (upsertRow) {
      const row = upsertRow;
      if (db[table].some((r) => r.fan_id === row.fan_id && r.day === row.day)) return { data: [], error: null };
      db[table].push({ ...row });
      return { data: [{ day: row.day }], error: null };
    }
    let rows = db[table].filter((r) => filters.every((f) => f(r)));
    rows = range ? rows.slice(range[0], range[1] + 1) : rows.slice(0, limit);
    if (cols.includes("fan:fans(")) {
      rows = rows.map((r) => ({ ...r, fan: { blocked_at: db.fans.find((f) => f.id === r.fan_id)?.blocked_at ?? null } }));
    }
    return { data: rows, error: null };
  };
  const b = {
    select(c: string) {
      if (!upsertRow) cols = c;
      return b;
    },
    upsert(row: Row) {
      upsertRow = row;
      return b;
    },
    eq(c: string, v: unknown) {
      filters.push((r) => r[c] === v);
      return b;
    },
    is(c: string, v: unknown) {
      filters.push((r) => (r[c] ?? null) === v);
      return b;
    },
    gte(c: string, v: string) {
      filters.push((r) => String(r[c]) >= v);
      return b;
    },
    lte(c: string, v: string) {
      filters.push((r) => String(r[c]) <= v);
      return b;
    },
    order() {
      return b;
    },
    limit(n: number) {
      limit = n;
      return b;
    },
    range(a: number, z: number) {
      range = [a, z];
      return b;
    },
    maybeSingle: async () => ({ data: exec().data[0] ?? null, error: null }),
    then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
      return Promise.resolve(exec()).then(res, rej);
    },
  };
  return b;
}
const client = { from };

mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => configured,
    createClient: async () => client,
    createServiceClient: () => client,
  },
});

async function main() {
  const { recordCheckin, readFanGlow, visitsByFan, fanVisitsLast7 } = await import("./checkins");
  const mockData = await import("./mock");
  const { token: mockToken, fanId: mockFanId } = mockData.mockCreatePass("Parity Fan", 3);

  // 45 days. Visits most days, with a 3-day gap, then a full week, then weekends off.
  const start = Date.parse("2026-09-01T15:00:00Z");
  const skip = new Set([3, 4, 5, 20, 26, 27, 33, 34, 40, 41]);
  const milestones: { day: number; real: unknown; demo: unknown }[] = [];
  let mismatches = 0;
  for (let i = 0; i < 45; i++) {
    if (skip.has(i)) continue;
    const now = new Date(start + i * 86_400_000);
    const local = now.toISOString().slice(0, 10);
    for (const visit of [0, 1]) {
      configured = true;
      const real = await recordCheckin("tok-1", local, now);
      configured = false;
      const demo = await recordCheckin(mockToken, local, now);
      if (JSON.stringify(real) !== JSON.stringify(demo)) {
        mismatches++;
        console.error("day", i, "visit", visit, real, demo);
      }
      if ("milestone" in real && real.milestone) milestones.push({ day: i, real: real.milestone, demo: "milestone" in demo ? demo.milestone : null });
    }
  }
  check("every check-in answered identically on both paths", mismatches === 0);
  check("milestones fired on both paths on the same days", milestones.length > 0 && milestones.every((m) => m.real === m.demo));
  check("a same-day second visit never re-fires a milestone", new Set(milestones.map((m) => m.day)).size === milestones.length);
  check("the week milestone fired (a full week happened)", milestones.some((m) => m.real === "week"));

  // Creator reads + the fan page read, on the last day.
  const last = new Date(start + 44 * 86_400_000);
  configured = true;
  const byFan = await visitsByFan(client as never, "creator-a", last);
  const one = await fanVisitsLast7(client as never, "fan-1", last);
  const glow = await readFanGlow(client as never, "fan-1", last);
  check("creator list and drawer agree", byFan.get("fan-1") === one);
  check("fan page glow counts the same 7 days", glow?.visits === one);
  // Today, on both paths: the creator list (Supabase) and the demo list and drawer agree.
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  configured = true;
  await recordCheckin("tok-1", today, now);
  configured = false;
  await recordCheckin(mockToken, today, now);
  configured = true;
  const realNow = (await visitsByFan(client as never, "creator-a", now)).get("fan-1");
  const listed = mockData.mockListFans().find((f) => f.fanId === mockFanId);
  check("demo list agrees with Supabase today", realNow === 1 && listed?.visits7 === realNow);
  check("demo drawer agrees with Supabase today", mockData.mockGetFanDetail(mockFanId)?.visits7 === (await fanVisitsLast7(client as never, "fan-1", now)));

  // The gate closes the read too.
  db.fans[0].blocked_at = "2026-10-01T00:00:00Z";
  check("blocked fan: no glow on the page", (await readFanGlow(client as never, "fan-1", last)) === null);
  const refused = await recordCheckin("tok-1", last.toISOString().slice(0, 10), last);
  check("blocked fan: check-in refused", "error" in refused && refused.error === "not_allowed");

  // Balances never moved.
  check("Supabase balances untouched", db.fans[0].spins_remaining === 3 && db.fan_passes[0].spins_remaining === 3);
  const demoFan = mockData.mockListFans().find((f) => f.fanId === mockFanId);
  check("demo balance untouched", demoFan?.spinsRemaining === 3 && demoFan.grantedTotal === 3);

  console.log(`check-in parity: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
