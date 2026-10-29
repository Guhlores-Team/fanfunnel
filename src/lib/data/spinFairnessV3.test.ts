import assert from "node:assert";
import { mock } from "node:test";
import { sha256Hex } from "@/lib/games/wheel/fairness";
import { hashPoolSnapshot, parsePoolSnapshot, replayV3, type FairTrace } from "@/lib/games/wheel/fairnessV3";

// Fairness v3 on the Supabase path, end to end: completeClaimedSpin records the
// pool snapshot + hash + trace, getSpinVerification reads them back, and the
// public verify page replays the draw. Older rows (no fair_version) and a DB
// without migration 0047 still verify exactly as before, and a tampered row is
// reported, not passed.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

// --- scriptable fake Supabase client (see spinCommitment.test.ts) -------------
type Op = { name: string; args: unknown[] };
type Resp = { data: unknown; error: { message: string } | null };
type Handler = (ops: Op[]) => Resp;
const ok = (data: unknown): Resp => ({ data, error: null });
const fail = (message: string): Resp => ({ data: null, error: { message } });
const has = (ops: Op[], name: string, arg?: string) =>
  ops.some((o) => o.name === name && (arg === undefined || String(o.args[0]).includes(arg)));


// Creator-filtered list reads and tenant-scoped single-wheel reads are distinct
// PostgREST contracts. A stored-wheel fallback must retain BOTH scope filters.
function assertStoredWheelScope(table: string, ops: Op[]) {
  if (table !== "wheels" || !ops.some((o) => o.name === "select" && o.args[0] === "id,archived_at")) return;
  assert.ok(has(ops, "maybeSingle"), "stored-wheel lookup expects a single row");
  assert.ok(ops.some((o) => o.name === "eq" && o.args[0] === "id" && o.args[1] === "wheel-1"), "stored-wheel lookup retains the requested wheel id");
  assert.ok(ops.some((o) => o.name === "eq" && o.args[0] === "creator_id" && o.args[1] === "creator-1"), "stored-wheel lookup retains the pass creator scope");
}

function fakeClient(handlers: Record<string, Handler>) {
  const builder = (table: string) => {
    const ops: Op[] = [];
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            return (res: (v: Resp) => unknown, rej: (e: unknown) => unknown) => {
              const h = handlers[table];
              if (!h) return Promise.reject(new Error(`no handler for ${table}`)).then(res, rej);
              assertStoredWheelScope(table, ops);
              return Promise.resolve(h(ops)).then(res, rej);
            };
          }
          return (...args: unknown[]) => {
            ops.push({ name: String(prop), args });
            return proxy;
          };
        },
      },
    );
    return proxy;
  };
  return { from: (table: string) => builder(table), rpc: async () => ok(null) };
}

let serviceClient: ReturnType<typeof fakeClient> | null = null;
mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => true,
    createServiceClient: () => {
      assert.ok(serviceClient, "a test set the service client");
      return serviceClient;
    },
    createClient: async () => {
      throw new Error("the verify path must not use a session client");
    },
  },
});

const SEED = "f".repeat(64);
const PRIZES = [
  // Limited and heavily weighted, so the first draw lands on it and the stock
  // compare-and-swap below loses: a recorded sold-out re-draw.
  { id: "prize-legend", label: "Legend", rarity: "legendary", weight: 1_000_000, stock: 1 },
  { id: "prize-b", label: "Bravo", rarity: "common", weight: 30, stock: null },
  { id: "prize-a", label: "Alpha", rarity: "rare", weight: 10, stock: null },
].map((p, i) => ({
  ...p,
  description: "creator-only note",
  color: null,
  emoji: i === 2 ? "🎁" : null,
  image_url: null,
  cost_cents: 777,
  sort_order: i,
}));

function wheelRow() {
  return {
    id: "wheel-1", title: "W", subtitle: null, brand_color: null, label_color: null,
    label_size: null, is_active: true, active_from: null, active_until: null, archived_at: null, game_ready: true,
    prizes: PRIZES,
  };
}

/** One Supabase-path spin; returns the spins insert payload and the response. */
async function realSpin(opts: { happyHour?: number; spinsInsert?: (row: Record<string, unknown>) => Resp }) {
  const { completeClaimedSpin } = await import("./spins");
  const inserts: Record<string, unknown>[] = [];
  const pass = {
    id: "pass-1", creator_id: "creator-1", campaign_id: null, wheel_id: "wheel-1", fan_id: "fan-1",
    next_server_seed: SEED, next_server_seed_hash: await sha256Hex(SEED),
  };
  const sb = fakeClient({
    fan_passes: (ops) => (has(ops, "update") ? ok({ id: pass.id }) : ok(pass)),
    campaigns: () => ok(null),
    wheels: (ops) => (has(ops, "eq", "creator") && !has(ops, "maybeSingle") ? ok([]) : ok(wheelRow())),
    fans: () => ok({ pity_counter: 4 }),
    happy_hours: () =>
      ok(opts.happyHour ? [{ multiplier: opts.happyHour, ends_at: new Date(Date.now() + 60_000).toISOString() }] : []),
    // The stock CAS on the limited prize loses; the re-read finds it sold out.
    prizes: (ops) => (has(ops, "update") ? ok(null) : ok({ stock: 0 })),
    spins: (ops) => {
      const ins = ops.find((o) => o.name === "insert");
      if (!ins) return ok(null);
      const row = ins.args[0] as Record<string, unknown>;
      inserts.push(row);
      return opts.spinsInsert ? opts.spinsInsert(row) : ok({ id: "spin-1", share_id: "share-1" });
    },
    redemptions: () => ok(null),
  });
  const res = await completeClaimedSpin(sb as never, "tok", "client-seed", 6);
  return { res, inserts };
}

/** A jsonb read: keys come back in a different order. */
const jsonb = <T,>(v: T): T => {
  const flip = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(flip)
      : x && typeof x === "object"
        ? Object.fromEntries(Object.entries(x).reverse().map(([k, y]) => [k, flip(y)]))
        : x;
  return JSON.parse(JSON.stringify(flip(v)));
};

async function renderVerify(row: Record<string, unknown> | null, opts: { pre0047?: boolean } = {}) {
  serviceClient = fakeClient({
    spins: (ops) => {
      const sel = String(ops.find((o) => o.name === "select")?.args[0] ?? "");
      if (opts.pre0047 && /fair_version/.test(sel)) return fail('column spins.fair_version does not exist');
      return ok(row);
    },
  });
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { default: VerifyPage } = await import("@/app/verify/[shareId]/page");
  const el = await VerifyPage({ params: Promise.resolve({ shareId: "share-1" }) });
  return renderToStaticMarkup(el).replace(/&#x27;|&rsquo;|’/g, "'");
}

async function main() {
  // --- the spin records v3 --------------------------------------------------------
  const { res, inserts } = await realSpin({ happyHour: 2 });
  assert.ok(!("error" in res), "spin succeeded");
  const row = inserts[0];
  check("spin row is fair_version 3", row.fair_version === 3);
  const parsed = parsePoolSnapshot(row.pool_snapshot);
  check("spin row carries a readable canonical snapshot", parsed.ok);
  check("pool_hash is the snapshot's SHA-256", parsed.ok && row.pool_hash === (await hashPoolSnapshot(parsed.snapshot)));
  const snapJson = JSON.stringify(row.pool_snapshot);
  check("snapshot has no cost and no creator-private field", !/cost|777|description|creator-only/.test(snapJson));
  check("snapshot records the happy hour and the fan's pity state", /"happyHour":\{"multiplier":2\}/.test(snapJson) && /"counter":4/.test(snapJson));
  const trace = row.fair_trace as FairTrace;
  check("the lost stock race is recorded as a sold-out re-draw", trace.excluded.length === 1 && trace.excluded[0] === "prize-legend");
  check("trace records the won prize, matching the row", trace.won === row.prize_id && row.prize_id !== "prize-legend");
  check("spin response carries the pool hash and version", !("error" in res) && res.poolHash === row.pool_hash && res.fairVersion === 3);
  check("spin response carries no cost", !/cost/.test(JSON.stringify(res)));

  const stored = {
    prize_label: row.prize_label, prize_rarity: row.prize_rarity, server_seed: row.server_seed,
    server_seed_hash: row.server_seed_hash, nonce: row.nonce, client_seed: row.client_seed,
    created_at: "2026-10-27T12:00:00.000Z", seed_commitment: row.seed_commitment, prize_id: row.prize_id,
    fair_version: row.fair_version, pool_snapshot: jsonb(row.pool_snapshot), pool_hash: row.pool_hash,
    fair_trace: jsonb(row.fair_trace),
  };
  const rep = await replayV3({
    serverSeed: String(stored.server_seed), clientSeed: stored.client_seed as string, nonce: Number(stored.nonce),
    snapshot: stored.pool_snapshot, poolHash: stored.pool_hash as string, trace: stored.fair_trace,
    prizeId: stored.prize_id as string, prizeLabel: String(stored.prize_label),
  });
  check("the stored row replays to the same prize", rep.ok && rep.replayed?.id === row.prize_id);

  // --- the verify page replays it -------------------------------------------------------
  const html = await renderVerify(stored);
  check("v3: the seed check still reads 'Hash matches'", /hash matches/i.test(html));
  check("v3: shows 'Odds used for this spin'", /Odds used for this spin/.test(html));
  check("v3: says the odds were locked in before the draw", /locked in before/i.test(html));
  check("v3: the replay passes", /Replayed: these odds and seeds draw/.test(html));
  check("v3: the odds table is a captioned table with column and row headers", /<table[^>]*>.*<caption/.test(html) && /scope="col"/.test(html) && /scope="row"/.test(html));
  check("v3: every prize in the pool is listed with its chance", /Alpha/.test(html) && /Bravo/.test(html) && /%/.test(html));
  check("v3: the sold-out re-draw is disclosed", /Legend was drawn first but had just sold out/.test(html));
  check("v3: the happy hour is disclosed", /Happy hour: rare, epic and legendary prizes had ×2 tickets/.test(html));
  check("v3: no cost reaches the page", !/cost|creator-only/i.test(html));
  check("v3: the formula names poolHash", /serverSeed:clientSeed:nonce:poolHash:block/.test(html));

  // --- tampering is reported ---------------------------------------------------------------
  const tampered = structuredClone(stored) as typeof stored & { pool_snapshot: { prizes: { id: string; w: number }[] } };
  tampered.pool_snapshot.prizes.find((p) => p.id === "prize-b")!.w += 1;
  const htmlT = await renderVerify(tampered);
  check("tampered odds: the page says the odds don't replay", /Odds don't replay/.test(htmlT) && /Replay failed/.test(htmlT));
  check("tampered odds: no 'Hash matches' pass", !/✓ Hash matches/.test(htmlT));
  check("tampered odds: the fingerprint mismatch is stated", /does not give this fingerprint/.test(htmlT));

  // --- older spins verify exactly as before -------------------------------------------------
  const legacySeed = "a".repeat(64);
  const legacy = {
    prize_label: "Alpha", prize_rarity: "rare", server_seed: legacySeed, server_seed_hash: await sha256Hex(legacySeed),
    nonce: 3, client_seed: "cs", created_at: "2026-01-01T00:00:00.000Z", seed_commitment: "published",
    prize_id: "prize-a", fair_version: null, pool_snapshot: null, pool_hash: null, fair_trace: null,
  };
  const htmlL = await renderVerify(legacy);
  check("v2 spin: 'Hash matches'", /✓ Hash matches/.test(htmlL));
  check("v2 spin: no odds section (nothing to replay)", !/Odds used for this spin/.test(htmlL));
  check("v2 spin: keeps the v2 explanation", /SHA-256\(serverSeed:clientSeed:nonce:block\)/.test(htmlL) && /does not re-simulate the full prize pool/.test(htmlL));
  const htmlPre = await renderVerify(legacy, { pre0047: true });
  check("DB without 0047: falls back and still verifies the seed", /✓ Hash matches/.test(htmlPre) && !/Odds used/.test(htmlPre));
  const htmlUntracked = await renderVerify({ ...legacy, seed_commitment: null, client_seed: null });
  check("v1/untracked spin: still 'Hash matches'", /✓ Hash matches/.test(htmlUntracked));

  // --- a DB without 0047: the spin still lands, recorded as before --------------------------
  {
    const { res: r2, inserts: ins2 } = await realSpin({
      spinsInsert: (row) =>
        "pool_snapshot" in row
          ? fail('Could not find the \'pool_snapshot\' column of \'spins\' in the schema cache')
          : ok({ id: "spin-2", share_id: "share-2" }),
    });
    check("pre-0047: the spin succeeds on the retry", !("error" in r2));
    check("pre-0047: the retry drops only the v3 columns", ins2.length === 2 && !("fair_version" in ins2[1]) && ins2[1].seed_commitment === "published");
    check("pre-0047: the response claims no v3", !("error" in r2) && r2.fairVersion === undefined && r2.poolHash === undefined);
  }

  console.log(`spinFairnessV3.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
