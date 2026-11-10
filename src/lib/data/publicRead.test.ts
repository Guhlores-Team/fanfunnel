import assert from "node:assert";
import { mock } from "node:test";

// OPS3-06: the public readers behind /share, /verify and /leaderboard tell a
// failed database read (FanPassUnavailableError → the route's error.tsx) apart from a missing
// row (null → the branded 404). Older-schema column misses still fall back.

let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };

type Result = { data: unknown; error: { code?: string; message: string } | null; count?: number | null };
const queue: Result[] = [];
const calls: string[] = [];
function query(table: string): unknown {
  calls.push(table);
  const q: Record<string, unknown> = {};
  const self = () => q;
  for (const m of ["select", "eq", "gt", "gte", "lte", "is", "not", "in", "order", "limit"]) q[m] = self;
  q.maybeSingle = () => Promise.resolve(queue.shift() ?? { data: null, error: null });
  q.then = (resolve: (r: Result) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(queue.shift() ?? { data: [], error: null, count: 0 }).then(resolve, reject);
  return q;
}
mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => true,
    createServiceClient: () => ({ from: query }),
    createClient: async () => ({ from: query }),
  },
});

const PROFILE = { id: "11111111-1111-4111-8111-111111111111", display_name: "Ada", is_active: true, approval_status: "approved", public_slug: "ada" };
const SPIN = { creator_id: PROFILE.id, prize_label: "Sticker", prize_rarity: "common", prize_image_url: null, created_at: "2026-01-01T00:00:00Z", game_kind: "wheel" };
const DOWN = { code: "57P01", message: "terminating connection due to administrator command" };

async function rejects(p: Promise<unknown>, name: string): Promise<boolean> {
  try { await p; return false; } catch (e) { return (e as Error).name === name; }
}

async function main() {
  const { getShareCard, getSpinVerification, getLeaderboard } = await import("./boosts");
  const { readPublicCreator } = await import("./publicCreatorRow");

  // readPublicCreator: a missing row and a bad uuid are null; a failure throws.
  queue.push({ data: null, error: null });
  check("no profile row → null", (await readPublicCreator({ from: query } as never, PROFILE.id, { by: "id" })) === null);
  queue.push({ data: null, error: { code: "22P02", message: "invalid input syntax for type uuid" } });
  check("a non-uuid id → null (not an outage)", (await readPublicCreator({ from: query } as never, "nope", { by: "id" })) === null);
  queue.push({ data: null, error: DOWN });
  check("a failed profile read throws FanPassUnavailableError", await rejects(readPublicCreator({ from: query } as never, PROFILE.id, { by: "id" }), "FanPassUnavailableError"));
  queue.push({ data: PROFILE, error: null });
  check("a public profile is returned", (await readPublicCreator({ from: query } as never, PROFILE.id, { by: "id" }))?.display_name === "Ada");

  // getShareCard
  queue.push({ data: null, error: null });
  check("share: unknown id → null", (await getShareCard("abc")) === null);
  queue.push({ data: null, error: DOWN });
  check("share: failed read throws", await rejects(getShareCard("abc"), "FanPassUnavailableError"));
  queue.push({ data: SPIN, error: null }, { data: PROFILE, error: null });
  check("share: a row renders", (await getShareCard("abc"))?.prizeLabel === "Sticker");
  queue.push({ data: SPIN, error: null }, { data: null, error: DOWN });
  check("share: the creator read failing throws too", await rejects(getShareCard("abc"), "FanPassUnavailableError"));

  // getSpinVerification: column misses fall back, outages throw.
  queue.push({ data: null, error: null });
  check("verify: unknown id → null", (await getSpinVerification("abc")) === null);
  queue.push({ data: null, error: DOWN });
  check("verify: failed read throws", await rejects(getSpinVerification("abc"), "FanPassUnavailableError"));
  const missing = { code: "42703", message: "column spins.fair_trace does not exist" };
  calls.length = 0;
  queue.push({ data: null, error: missing }, { data: null, error: missing }, { data: null, error: null });
  check("verify: an older schema falls back twice then answers null", (await getSpinVerification("abc")) === null && calls.length === 3);
  queue.push({ data: null, error: missing }, { data: null, error: DOWN });
  check("verify: an outage after a column fallback still throws", await rejects(getSpinVerification("abc"), "FanPassUnavailableError"));
  queue.push({ data: { ...SPIN, kind: "bonus", parent_spin_id: "p", bingo_line: 1, server_seed: null, server_seed_hash: null }, error: null }, { data: PROFILE, error: null }, { data: null, error: DOWN });
  check("verify: a bonus whose parent read fails throws", await rejects(getSpinVerification("abc"), "FanPassUnavailableError"));

  // getLeaderboard
  queue.push({ data: null, error: null });
  check("board: unknown creator → null", (await getLeaderboard(PROFILE.id)) === null);
  queue.push({ data: null, error: DOWN });
  check("board: failed profile read throws", await rejects(getLeaderboard(PROFILE.id), "FanPassUnavailableError"));
  queue.push({ data: { ...PROFILE, leaderboard_enabled: true }, error: null }, { data: null, error: DOWN, count: null });
  const boardErr = await getLeaderboard(PROFILE.id).then(() => null, (e: Error) => e);
  check("board: a failed fan read throws (CompleteReadError), never an empty board", boardErr?.name === "CompleteReadError");
  queue.push({ data: { ...PROFILE, leaderboard_enabled: true }, error: null }, { data: [], error: null, count: 0 });
  check("board: no opted-in fans → an open, empty board", (await getLeaderboard(PROFILE.id))?.entries.length === 0);

  console.log(`publicRead.test: ${passed} checks passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
