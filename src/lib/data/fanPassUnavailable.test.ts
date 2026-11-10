import assert from "node:assert";
import { mock } from "node:test";

// A21: getFanPass has no legacy-schema fallbacks any more. A transient
// database fault must surface as a retryable error (the route error boundary
// offers "try again"), never silently degrade to "link not found" or to the
// fan-level aggregate balance; only a genuinely missing/inactive link is null.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

type Op = { name: string; args: unknown[] };
type Resp = { data: unknown; error: { message: string } | null };
let passRead: () => Resp = () => ({ data: null, error: null });
let commitRead: () => Resp = () => ({ data: { hash: "a".repeat(64) }, error: null });
const selects: string[] = [];
function fakeClient() {
  const builder = (table: string) => {
    const ops: Op[] = [];
    const proxy: unknown = new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") {
          return (res: (v: Resp) => unknown, rej: (e: unknown) => unknown) => {
            if (table === "fan_passes") {
              selects.push(String(ops.find((o) => o.name === "select")?.args[0] ?? ""));
              return Promise.resolve(passRead()).then(res, rej);
            }
            return Promise.resolve({ data: [], error: null }).then(res, rej);
          };
        }
        return (...args: unknown[]) => { ops.push({ name: String(prop), args }); return proxy; };
      },
    });
    return proxy;
  };
  return { from: (table: string) => builder(table), rpc: async (name: string) => (name === "ensure_pass_commitment" ? commitRead() : { data: null, error: null }) };
}
mock.module("@/lib/supabase/server", {
  namedExports: { isSupabaseConfigured: () => true, createServiceClient: () => fakeClient(), createClient: async () => fakeClient() },
});

async function main() {
  const { getFanPass, FanPassUnavailableError } = await import("./spins");

  check("an unknown or inactive link is null (the 404 path)", (await getFanPass("missing")) === null);
  check("the read asks for the per-pass balance and the commitment hash in ONE select", selects.length === 1 && /spins_remaining/.test(selects[0]) && /next_server_seed_hash/.test(selects[0]));

  passRead = () => ({ data: null, error: { message: "canceling statement due to statement timeout" } });
  selects.length = 0;
  let thrown: unknown = null;
  try { await getFanPass("tok"); } catch (e) { thrown = e; }
  check("a failing select throws FanPassUnavailableError instead of returning null", thrown instanceof FanPassUnavailableError);
  check("no legacy fallback select is attempted", selects.length === 1);

  passRead = () => ({ data: {
    id: "pass-1", creator_id: "creator-1", campaign_id: null, wheel_id: "wheel-1", fan_id: "fan-1", is_active: true,
    spins_remaining: 0, next_server_seed_hash: null,
    fan: { id: "fan-1", display_name: "Sam", handle: null, spins_remaining: 18, spins_granted_total: 18, referral_code: "ABC", acked_at: null, acked_terms_version: null, leaderboard_opt_in: false, blocked_at: null },
    creator: { display_name: "Creator", tip_url: null, leaderboard_enabled: false, creator_note: null, avatar_url: null, is_active: true, approval_status: "approved", role: "creator" },
  }, error: null });
  commitRead = () => ({ data: null, error: { message: "connection reset" } });
  thrown = null;
  try { await getFanPass("tok"); } catch (e) { thrown = e; }
  check("a failing commitment write throws too (no page without a published hash)", thrown instanceof FanPassUnavailableError);

  // Static: the fan read has exactly one fan_passes select and no fallback.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./spins.ts", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("const fanReadClient"), src.indexOf("export async function spin("));
  check("the fan page path reads fan_passes exactly once (readFanPassRow) and never mentions a legacy/pre-0020 fallback", (fn.match(/\.from\("fan_passes"\)/g) ?? []).length === 1 && !/legacy|pre-0020|pre-0022|hasPerPass/.test(fn));
  check("OPS3-02: the read is bounded (timed client + page deadline)", /createServiceClient\(\{ timeoutMs: FAN_READ_TIMEOUT_MS \}\)/.test(fn) && /withFanDeadline\(readFanPassView\(token\), FAN_PAGE_DEADLINE_MS/.test(fn));
  check("the balance shown is the per-pass one, never the fan aggregate", /spinsRemaining: pass\.spins_remaining/.test(fn) && !/pass\.fan\.spins_remaining,\n/.test(fn.slice(fn.indexOf("spinsRemaining:"), fn.indexOf("spinsRemaining:") + 80)));

  console.log(`fanPassUnavailable.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
