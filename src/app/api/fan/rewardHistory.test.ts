import assert from "node:assert/strict";
import { mock } from "node:test";
import { randomBytes } from "node:crypto";
import { encodeRewardHistoryCursor, rewardHistoryTimestamp } from "@/lib/rewards/history";
import { sealReward } from "@/lib/rewards/crypto";

let passed = 0;
const check = (label: string, ok: unknown) => { assert.ok(ok, label); passed++; };
process.env.REWARD_ENCRYPTION_KEY = randomBytes(32).toString("base64");
const sealed = sealReward("OWNED-SECRET", "creator-a");
type Row = Record<string, unknown>;
let blocked = false, paused = false, inactive = false, viewFails = false, invalidateDuringRead = false;
const viewCalls: {name:string,args:Record<string,unknown>}[] = [];
const rows: Row[] = Array.from({ length: 55 }, (_, i) => ({ id: `internal-${i}`, share_id: `share${String(i).padStart(3, "0")}`,
  fan_id: "fan-a", creator_id: "creator-a", prize_label: "Repeated prize", prize_rarity: "common",
  created_at: `2026-01-01T00:00:00.${String(i+1).padStart(6,"0")}+00:00`, reward: { kind: "code" } }));
rows.push({ id: "other-id", share_id: "otherShare", fan_id: "fan-b", creator_id: "creator-b", prize_label: "PRIVATE OTHER FAN", prize_rarity: "rare", created_at: "2026-01-02T00:00:00.000Z", reward: { kind: "code" } });
const selections: string[] = [];
function query(table: string) {
  const filters: [string, unknown][] = [];
  let limit = Infinity, cursor = "";
  const execute = () => {
    if (table === "fan_passes") {
      const token = filters.find(([key]) => key === "token")?.[1];
      return token === "token-a" ? { data: { fan_id: "fan-a", creator_id: "creator-a", is_active: !inactive,
        self_excluded_at: paused ? "2026-01-01" : null, fan: { blocked_at: blocked ? "2026-01-01" : null }, creator: { is_active: true } }, error: null } : { data: null, error: null };
    }
    if (table === "spin_rewards") { if(invalidateDuringRead) blocked=true; return { data: { kind: "code", cipher: sealed.cipher, iv: sealed.iv, key_version: sealed.keyVersion, created_at: "2026-01-01T00:00:00.000Z" }, error: null }; }
    let found = rows.filter((r) => filters.every(([key, value]) => r[key] === value));
    if (cursor) {
      const match = cursor.match(/^created_at\.lt\.([^,]+),and\(created_at\.eq\.([^,]+),share_id\.lt\.([A-Za-z0-9_-]+)\)$/);
      assert.ok(match, "only validated cursor coordinates enter the PostgREST filter");
      found = found.filter((r) => rewardHistoryTimestamp(r.created_at)! < rewardHistoryTimestamp(match[1])! || (rewardHistoryTimestamp(r.created_at) === rewardHistoryTimestamp(match[2]) && String(r.share_id) < match[3]));
    }
    found.sort((a, b) => rewardHistoryTimestamp(b.created_at)!.localeCompare(rewardHistoryTimestamp(a.created_at)!) || String(b.share_id).localeCompare(String(a.share_id)));
    return { data: found.slice(0, limit), error: null };
  };
  const q: Record<string, unknown> = {
    select: (columns: string) => { selections.push(columns); return q; },
    eq: (key: string, value: unknown) => { filters.push([key, value]); return q; },
    not: () => q, order: () => q,
    limit: (n: number) => { limit = n; return q; },
    or: (value: string) => { cursor = value; return q; },
    maybeSingle: async () => { const result = execute(); return { ...result, data: Array.isArray(result.data) ? result.data[0] ?? null : result.data }; },
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(execute()).then(resolve),
  };
  return q;
}
mock.module("@/lib/supabase/server", { namedExports: {
  isSupabaseConfigured: () => true, createClient: async () => { throw new Error("fan history must not use a creator session"); },
  createServiceClient: () => ({ from: query, rpc: async (name:string,args:Record<string,unknown>) => { viewCalls.push({name,args}); return viewFails ? { data: null, error: { message: "view log unavailable" } } : { data: name==="record_fan_reward_view" && args.p_token==="token-a" && !blocked && !paused && !inactive ? 2 : null, error: null }; } }),
} });
mock.module("@/lib/rateLimit", { namedExports: { rateLimitShared: async () => ({ ok: true, retryAfter: 0 }) } });
async function main() {
  const { POST } = await import("./reward/history/route");
  const { getFanReward } = await import("@/lib/data/rewards");
  const call = (body: unknown) => POST(new Request("http://localhost/api/fan/reward/history", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(body) }));
  let cursor: string | undefined;
  const refs: {shareId:string}[] = [];
  for (const expected of [20, 20, 15]) {
    const response = await call({ token: "token-a", cursor, fanId: "fan-b", creatorId: "creator-b" });
    const body = await response.json();
    check("history is no-store", response.headers.get("cache-control") === "no-store");
    check(`history page has ${expected} own references`, response.status === 200 && body.wins.length === expected);
    check("only sanitized public reference fields", body.wins.every((w:Row) => Object.keys(w).sort().join() === "at,label,rarity,shareId"));
    check("forged owner input cannot select another fan", !JSON.stringify(body).includes("PRIVATE OTHER FAN") && !JSON.stringify(body).includes("OWNED-SECRET"));
    refs.push(...body.wins); cursor = body.nextCursor ?? undefined;
  }
  check("all55 sub-millisecond historical wins remain accessible without duplicates", refs.length === 55 && new Set(refs.map((r) => r.shareId)).size === 55 && !cursor);
  check("history never selects ciphertext or IV", selections.filter((s) => s.includes("spin_rewards")).every((s) => !/cipher|\biv\b/.test(s)));
  for (const bad of [null, {}, {token:"token-a",cursor:42}, {token:"token-a",cursor:"../../x"}, {token:"token-a",cursor:"x".repeat(257)}]) check("bad history input is400", (await call(bad)).status === 400);
  check("unknown token is404", (await call({token:"missing"})).status === 404);
  blocked=true;check("blocked fan is403", (await call({token:"token-a"})).status===403);blocked=false;
  paused=true;check("paused link is403", (await call({token:"token-a"})).status===403);paused=false;
  inactive=true;check("inactive link is404", (await call({token:"token-a"})).status===404);inactive=false;
  const cross = encodeRewardHistoryCursor({shareId:"otherShare",at:"2026-01-02T00:00:00.000Z"});
  check("another fan's cursor cannot anchor own history", (await call({token:"token-a",cursor:cross})).status===400);
  const before = await getFanReward("token-a","share000");check("own re-view works when logging succeeds", !("error" in before) && before.views===2);
  viewFails=true;const failure=await getFanReward("token-a","share000");
  check("view logging failure returns no plaintext", "error" in failure && failure.error==="db_error" && !JSON.stringify(failure).includes("OWNED-SECRET"));
  viewFails=false; invalidateDuringRead=true;
  const invalidated=await getFanReward("token-a","share000");
  check("a link invalidated between read and view write discloses no value", "error" in invalidated && invalidated.error==="db_error");
  check("view logging rechecks the exact token and owned spin on the server", viewCalls.every((c)=>c.name==="record_fan_reward_view" && c.args.p_token==="token-a" && c.args.p_spin==="internal-0"));
  console.log(`reward history/authz: ${passed} checks passed`);
}
main().catch((e)=>{console.error(e);process.exit(1);});
