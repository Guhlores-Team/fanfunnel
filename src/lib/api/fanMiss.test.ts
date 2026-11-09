import assert from "node:assert";
import { NextResponse } from "next/server";
import { withFanToken } from "./fanToken";
import { FAN_MISS_LIMIT, resetFanMissBlocks, withFanMissLimit } from "./fanMiss";
import { ROUTE_TIERS } from "./limit";
import { ROUTE_TIERS as TIERS } from "./routeTiers";

// C2 (batch 6 attack audit): fan routes key their limit on the token, so a
// fresh random token per request was never limited. Lookups that MISS (404)
// are now capped per address at the public tier; a hit is never counted.

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
  check("a blocked address is refused before any lookup", blocked.status === 429 && lookups === before && Number(blocked.headers.get("Retry-After")) >= 1);

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
  check("/spin/<token> checks the block before its lookup and counts a miss", /missBlocked\(\)\) notFound\(\);\s*const pass = await getFanPass/.test(page) && page.includes("await noteFanMiss("));

  console.log(`fanMiss.test: ${passed} checks passed`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
