import assert from "node:assert";
import { mock } from "node:test";

// AUTH-SENSITIVE (AGENTS.md rules 5/7): POST /api/fan/checkin records a fan's
// visit for the RM-3 glow. Fans have no session; the link token is the only
// credential, so the route resolves the fan server-side with the service role.
//
// Negative tests: a malformed body never reaches the database; an unknown,
// deactivated or paused link is 404 with no write; a blocked fan is 403 with no
// write (200 with no glow: the link still opens); ids in the body (another fan, another creator) are ignored — the row
// always belongs to the token's own fan and creator; a date outside UTC ± 1 is
// clamped; the route is rate-limited; the auth-scoped client is never used;
// and nothing but fan_checkins is ever written (no balance, pass or spin: a
// visit never grants spins). Demo mode (mock store) gives the same answers.
// The database half (RLS: creators and anon can't write, B's rows hidden from
// A) is in scripts/db/schema-drift-check.mjs and
// scripts/security/rls-runtime-test.mjs.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = { fans: [], fan_passes: [], fan_checkins: [] };
const writes: { table: string; op: string; row: Row }[] = [];
let configured = true;

/** The slice of the supabase-js builder recordCheckin uses, over `db`. */
function from(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  let cols = "";
  let upsert: { row: Row; ignoreDuplicates: boolean } | null = null;
  let limit = Infinity;
  const exec = (): { data: Row[]; error: null } => {
    if (upsert) {
      const { row } = upsert;
      const dup = db[table].some((r) => r.fan_id === row.fan_id && r.day === row.day);
      writes.push({ table, op: "upsert", row });
      if (dup) return { data: [], error: null };
      db[table].push({ ...row });
      return { data: [{ day: row.day }], error: null };
    }
    let rows = db[table].filter((r) => filters.every((f) => f(r))).slice(0, limit);
    if (table === "fan_passes" && cols.includes("fan:fans(")) {
      rows = rows.map((r) => {
        const fan = db.fans.find((f) => f.id === r.fan_id);
        return { ...r, fan: fan ? { blocked_at: fan.blocked_at ?? null, break_until: fan.break_until ?? null } : null };
      });
    }
    return { data: rows, error: null };
  };
  const b = {
    select(c: string) {
      if (!upsert) cols = c;
      return b;
    },
    upsert(row: Row, opts: { onConflict?: string; ignoreDuplicates?: boolean }) {
      assert.strictEqual(opts.onConflict, "fan_id,day", "upsert keys on the primary key");
      upsert = { row, ignoreDuplicates: opts.ignoreDuplicates === true };
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
    update() {
      throw new Error(`the check-in must never UPDATE (${table})`);
    },
    insert() {
      throw new Error(`the check-in must never INSERT outside the upsert (${table})`);
    },
    delete() {
      throw new Error(`the check-in must never DELETE (${table})`);
    },
    rpc() {
      throw new Error("the check-in must never call an RPC");
    },
    maybeSingle: async () => ({ data: exec().data[0] ?? null, error: null }),
    then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
      return Promise.resolve(exec()).then(res, rej);
    },
  };
  return b;
}

mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => configured,
    createClient: async () => {
      throw new Error("the check-in route must never use a creator session");
    },
    createServiceClient: () => ({
      from,
      rpc: () => {
        throw new Error("the check-in must never call an RPC");
      },
    }),
  },
});

// Creator A: fan 1 (ok), fan 2 (blocked), fan 3 (paused link), fan 4 (old link
// deactivated), fan 5 (on a break, RM-6). Creator B: fan 9.
db.fans.push(
  { id: "fan-1", creator_id: "creator-a", blocked_at: null, spins_remaining: 4 },
  { id: "fan-2", creator_id: "creator-a", blocked_at: "2026-10-01T00:00:00Z", spins_remaining: 2 },
  { id: "fan-3", creator_id: "creator-a", blocked_at: null, spins_remaining: 1 },
  { id: "fan-4", creator_id: "creator-a", blocked_at: null, spins_remaining: 0 },
  { id: "fan-5", creator_id: "creator-a", blocked_at: null, break_until: new Date(Date.now() + 86_400_000).toISOString(), spins_remaining: 3 },
  { id: "fan-9", creator_id: "creator-b", blocked_at: null, spins_remaining: 7 }
);
db.fan_passes.push(
  { token: "tok-1", fan_id: "fan-1", creator_id: "creator-a", is_active: true, self_excluded_at: null, spins_remaining: 4 },
  { token: "tok-2", fan_id: "fan-2", creator_id: "creator-a", is_active: true, self_excluded_at: null, spins_remaining: 2 },
  { token: "tok-3", fan_id: "fan-3", creator_id: "creator-a", is_active: false, self_excluded_at: "2026-10-20T00:00:00Z", spins_remaining: 1 },
  { token: "tok-4", fan_id: "fan-4", creator_id: "creator-a", is_active: false, self_excluded_at: null, spins_remaining: 0 },
  { token: "tok-5", fan_id: "fan-5", creator_id: "creator-a", is_active: true, self_excluded_at: null, spins_remaining: 3 },
  { token: "tok-9", fan_id: "fan-9", creator_id: "creator-b", is_active: true, self_excluded_at: null, spins_remaining: 7 }
);
const balancesBefore = JSON.stringify([db.fans.map((f) => f.spins_remaining), db.fan_passes.map((p) => p.spins_remaining)]);

const utcToday = new Date().toISOString().slice(0, 10);
const shift = (n: number) => new Date(Date.parse(utcToday + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
let ipSeq = 0;

async function main() {
  const { POST } = await import("./route");
  const post = async (body: unknown, ip = `10.0.0.${++ipSeq % 250}`) => {
    const res = await POST(
      new Request("http://localhost/api/fan/checkin", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-real-ip": ip },
        body: typeof body === "string" ? body : JSON.stringify(body),
      })
    );
    return { status: res.status, data: (await res.json()) as Record<string, unknown>, cache: res.headers.get("cache-control") };
  };

  // --- 1. Malformed bodies never reach the database -------------------------------
  for (const bad of [{}, { token: "" }, { token: 42 }, { token: ["tok-1"] }, { token: null }, { token: "x".repeat(201) }]) {
    const r = await post(bad);
    check(`${JSON.stringify(bad).slice(0, 40)} → 400`, r.status === 400);
  }
  check("malformed JSON → 400", (await post("{nope")).status === 400);
  check("no write for a malformed body", writes.length === 0);

  // --- 2. Links that don't open don't count ---------------------------------------
  check("unknown token → 404", (await post({ token: "tok-unknown" })).status === 404);
  check("paused (self-excluded) link → 404", (await post({ token: "tok-3" })).status === 404);
  check("deactivated old link → 404", (await post({ token: "tok-4" })).status === 404);
  check("no write for a link that doesn't open", writes.length === 0);

  // --- 3. The engagement gate: a blocked fan gets no glow and no visit ------------
  const blocked = await post({ token: "tok-2", localDate: utcToday });
  check("blocked fan → no glow, no milestone", blocked.status === 200 && blocked.data.glow === null && blocked.data.milestone === null);
  check("…and nothing was written", writes.length === 0);
  const resting = await post({ token: "tok-5", localDate: utcToday });
  check("fan on a break → no glow, no milestone", resting.status === 200 && resting.data.glow === null && resting.data.milestone === null);
  check("…and no visit was written for them", writes.length === 0);

  // --- 4. A real visit -------------------------------------------------------------
  const first = await post({ token: "tok-1", localDate: utcToday });
  check("first visit → 200", first.status === 200);
  check("first visit → faint glow (1 day)", JSON.stringify(first.data.glow) === JSON.stringify({ visits: 1, level: 1 }));
  check("first visit → no milestone", first.data.milestone === null);
  check("response is no-store", /no-store/.test(first.cache ?? ""));
  check("response carries no spins, odds or balance", !("spinsRemaining" in first.data) && !("spins" in first.data) && !("odds" in first.data));
  check("one row written, to fan_checkins", writes.length === 1 && writes[0].table === "fan_checkins");
  check("the row is the token's own fan + creator", writes[0].row.fan_id === "fan-1" && writes[0].row.creator_id === "creator-a");

  const again = await post({ token: "tok-1", localDate: utcToday });
  check("same-day repeat → 200, same glow", again.status === 200 && (again.data.glow as { visits: number }).visits === 1);
  check("same-day repeat stores no second row", db.fan_checkins.filter((r) => r.fan_id === "fan-1").length === 1);

  // --- 5. Ids in the body are ignored: no writing for another fan or creator ------
  writes.length = 0;
  const sneaky = await post({
    token: "tok-1",
    localDate: shift(-1),
    fanId: "fan-9",
    fan_id: "fan-9",
    creatorId: "creator-b",
    creator_id: "creator-b",
  });
  check("body ids → still 200 for the token's own fan", sneaky.status === 200);
  check("…row is fan-1 / creator-a, never fan-9 / creator-b", writes.length === 1 && writes[0].row.fan_id === "fan-1" && writes[0].row.creator_id === "creator-a");
  check("creator B's fan has no visit", !db.fan_checkins.some((r) => r.fan_id === "fan-9" || r.creator_id === "creator-b"));

  // --- 6. Dates are clamped to UTC today ± 1 --------------------------------------
  writes.length = 0;
  await post({ token: "tok-1", localDate: "2001-01-01" });
  check("an old date is clamped to yesterday (no backfill)", writes[0]?.row.day === shift(-1));
  await post({ token: "tok-1", localDate: "2999-12-31" });
  check("a far-future date is clamped to tomorrow", writes[1]?.row.day === shift(1));
  await post({ token: "tok-1", localDate: "'; drop table fans; --" });
  check("a junk date falls back to UTC today", writes[2]?.row.day === utcToday);
  check("3 distinct days at most from one sitting", db.fan_checkins.filter((r) => r.fan_id === "fan-1").length === 3);

  // --- 7. Rate limit per IP + token ------------------------------------------------
  let limited = 0;
  for (let i = 0; i < 25; i++) if ((await post({ token: "tok-9", localDate: utcToday }, "10.9.9.9")).status === 429) limited++;
  check("over the limit → 429", limited === 5);
  check("another IP isn't limited by it", (await post({ token: "tok-9" }, "10.9.9.10")).status === 200);

  // --- 8. Nothing but fan_checkins was ever touched --------------------------------
  check("every write went to fan_checkins", writes.every((w) => w.table === "fan_checkins" && w.op === "upsert"));
  check(
    "no balance moved (fans and passes untouched)",
    JSON.stringify([db.fans.map((f) => f.spins_remaining), db.fan_passes.map((p) => p.spins_remaining)]) === balancesBefore
  );

  // --- 9. Demo mode: the mock store answers the same way ---------------------------
  configured = false;
  const mockData = await import("@/lib/data/mock");
  const { token: demoToken, fanId: demoFanId } = mockData.mockCreatePass("Glow Parity Fan", 3);
  check("demo: unknown token → 404", (await post({ token: "tok-unknown" })).status === 404);
  const d1 = await post({ token: demoToken, localDate: utcToday });
  check("demo: first visit → same glow as Supabase", d1.status === 200 && JSON.stringify(d1.data.glow) === JSON.stringify(first.data.glow) && d1.data.milestone === null);
  const d2 = await post({ token: demoToken, localDate: utcToday });
  check("demo: same-day repeat → same", JSON.stringify(d2.data.glow) === JSON.stringify(again.data.glow));
  mockData.mockSetFanBlocked(demoFanId, true);
  const demoBlocked = await post({ token: demoToken });
  check("demo: blocked → no glow", demoBlocked.status === 200 && demoBlocked.data.glow === null);
  mockData.mockSetFanBlocked(demoFanId, false);
  const { token: restToken } = mockData.mockCreatePass("Glow Resting Fan", 3);
  mockData.mockTakeBreak(restToken, 86_400_000);
  const demoResting = await post({ token: restToken, localDate: utcToday });
  check("demo: on a break → no glow", demoResting.status === 200 && demoResting.data.glow === null && demoResting.data.milestone === null);
  mockData.mockSelfExclude(demoToken);
  check("demo: paused → 404", (await post({ token: demoToken })).status === 404);

  console.log(`check-in route: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
