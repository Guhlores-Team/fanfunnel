import assert from "node:assert";
import { NextResponse } from "next/server";
import { withFanToken } from "./fanToken";
import { FAN_MISS_LIMIT, fanTokenKnownGood, noteFanMiss, resetFanMissBlocks, withFanMissLimit } from "./fanMiss";
import { ROUTE_TIERS } from "./limit";
import { ROUTE_TIERS as TIERS } from "./routeTiers";

// C2 (batch 6 attack audit): fan routes key their limit on the token, so a
// fresh random token per request was never limited. Lookups that MISS (404)
// are now capped per address at the public tier; a hit is never counted.
// ATK-04 (batch 7): the cap never refuses a request BEFORE its lookup, so a
// valid token behind a hostile NAT neighbour's address still works.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const KNOWN = "k".repeat(48);
let lookups = 0;
const lookup = async (token: string) => {
  lookups++;
  return token.startsWith("k") ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "not_found" }, { status: 404 });
};
const post = (ip: string, token: string) =>
  withFanToken(
    new Request("http://x/api/spin", { method: "POST", headers: { "x-real-ip": ip, "content-type": "application/json" }, body: JSON.stringify({ token }) }),
    { scope: "test", limit: 1000, windowMs: 60_000 },
    (t) => lookup(t),
  );
const rnd = () => Math.random().toString(16).slice(2).padEnd(48, "0");

async function main() {
  resetFanMissBlocks();
  check("the miss budget is the public route tier", FAN_MISS_LIMIT === ROUTE_TIERS.public && ROUTE_TIERS === TIERS && FAN_MISS_LIMIT.limit === 120);

  // Misses from one address: 404 up to the budget, then 429.
  const statuses: number[] = [];
  for (let i = 0; i < FAN_MISS_LIMIT.limit + 1; i++) statuses.push((await post("10.9.0.1", rnd())).status);
  check("random tokens get 404 up to the budget", statuses.slice(0, FAN_MISS_LIMIT.limit).every((s) => s === 404));
  check("…then 429 with a fresh random token", statuses.at(-1) === 429);
  const before = lookups;
  const blocked = await post("10.9.0.1", rnd());
  check("ATK-04: an over-budget address's next miss is refused AFTER its lookup (never before)", blocked.status === 429 && lookups === before + 1 && Number(blocked.headers.get("Retry-After")) >= 1);
  // The hostile neighbour's address is over budget; a real fan behind the same
  // address still spins, acks and chats.
  let neighbour = true;
  for (let i = 0; i < 20; i++) neighbour &&= (await post("10.9.0.1", KNOWN)).status === 200;
  check("ATK-04: a valid token behind an over-budget address still works", neighbour);
  check("…and is remembered as known-good (digest only)", fanTokenKnownGood(KNOWN));
  check("…while the address's misses stay refused", (await post("10.9.0.1", rnd())).status === 429);
  const lookupsBefore = lookups;
  check("a known-good token still runs its lookup (the cache spares only the bookkeeping)", (await post("10.9.0.1", KNOWN)).status === 200 && lookups === lookupsBefore + 1);
  check("a repeat miss from an over-budget address is answered from this instance's memory", (await noteFanMiss("10.9.0.1")).over);

  // Another address is untouched.
  check("another address still gets its 404", (await post("10.9.0.2", rnd())).status === 404);

  // Hits never count and are never slowed.
  let hitOk = true;
  for (let i = 0; i < 300; i++) hitOk &&= (await post("10.9.0.3", KNOWN)).status === 200;
  check("300 hits from one address are never refused", hitOk);
  for (let i = 0; i < FAN_MISS_LIMIT.limit - 1; i++) await post("10.9.0.4", rnd());
  let mixed = true;
  for (let i = 0; i < 50; i++) mixed &&= (await post("10.9.0.4", KNOWN)).status === 200;
  check("hits between misses never spend the miss budget", mixed && (await post("10.9.0.4", rnd())).status === 404);

  // Other answers (400, 200, 409) pass through uncounted.
  const r = await withFanMissLimit(new Request("http://x", { headers: { "x-real-ip": "10.9.0.5" } }), async () => NextResponse.json({ error: "conflict" }, { status: 409 }));
  check("a non-404 answer is returned untouched", r.status === 409);

  // Wired into every fan route outside withFanToken and the per-link pages.
  const { readFileSync } = await import("node:fs");
  const root = new URL("../../../", import.meta.url);
  for (const f of [
    "src/app/api/wishlists/route.ts",
    "src/app/api/report/route.ts",
    "src/app/api/fan/checkin/route.ts",
    "src/app/api/messages/fan/route.ts",
    "src/app/api/self-exclude/route.ts",
    "src/app/api/fans/ack/route.ts",
    "src/app/api/leaderboard/opt-in/route.ts",
    "src/app/api/fan-data/export/route.ts",
    "src/app/api/fan-data/delete/route.ts",
    "src/app/spin/[token]/manifest/route.ts",
    "src/app/spin/[token]/icon/[variant]/route.ts",
  ]) {
    const src = readFileSync(new URL(f, root), "utf8");
    const handlers = [...src.matchAll(/export async function (GET|POST|DELETE)\(/g)].length;
    check(`${f}: every handler runs under withFanMissLimit`, handlers > 0 && (src.match(/withFanMissLimit\(req,/g) ?? []).length === handlers);
  }
  const page = readFileSync(new URL("src/app/spin/[token]/page.tsx", root), "utf8");
  check("/spin/<token> never refuses before its lookup and counts only a genuine miss", !/missBlocked|fanMissBlockedFor/.test(page) && page.includes("await noteFanMiss(") && page.indexOf("await getFanPass(") < page.indexOf("await noteFanMiss("));
  const fanToken = readFileSync(new URL("src/lib/api/fanToken.ts", root), "utf8");
  check("withFanToken hands the token to the miss budget so hits are remembered", /\}, token\);/.test(fanToken));
  // WF-03 / WA-02: an over-budget address's miss gets the honest "too many
  // attempts" page, any other miss the branded 404; both after the lookup.
  check("/spin/<token> sends an over-budget miss to the busy page, else to the branded 404", /const \{ over, retryAfter \} = await noteFanMiss\(await visitorIp\(\)\);\s*if \(over\) linkAttemptsBlocked\(retryAfter\);\s*linkNotFound\("spin", token\);/.test(page));

  console.log(`fanMiss.test: ${passed} checks passed`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
