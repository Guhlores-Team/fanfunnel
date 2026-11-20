import assert from "node:assert";
import { mock } from "node:test";

// Batch 6 N4: a fan report stores a digest of the link token (plus a
// 4-character hint), never the bearer token; the hint, the fan's own export
// and erasure still find it, and legacy raw-token rows keep working.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcd";
const inserts: Record<string, unknown>[] = [];
const updates: { table: string; ops: [string, unknown[]][] }[] = [];
function from(table: string) {
  const ops: [string, unknown[]][] = [];
  const proxy: unknown = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") {
        return (res: (v: unknown) => unknown) => {
          const ins = ops.find(([o]) => o === "insert");
          if (ins) inserts.push(ins[1][0] as Record<string, unknown>);
          if (ops.some(([o]) => o === "update")) updates.push({ table, ops });
          const data = table === "fan_passes" ? { creator_id: "c1", fan_id: "f1" } : null;
          return Promise.resolve({ data, error: null }).then(res);
        };
      }
      return (...args: unknown[]) => { ops.push([String(prop), args]); return proxy; };
    },
  });
  return proxy;
}
mock.module("@/lib/supabase/server", { namedExports: { isSupabaseConfigured: () => true, createServiceClient: () => ({ from }), createClient: async () => ({ from }) } });

async function main() {
  const t = await import("./reportToken");
  const stored = t.storedReportToken(TOKEN);
  check("the stored form holds no part of the token beyond its last 4 characters", !stored.includes(TOKEN.slice(0, 40)) && stored.startsWith("t1:abcd:"));
  check("it matches its own token only", t.reportTokenMatches(stored, TOKEN) && !t.reportTokenMatches(stored, TOKEN.replace("0", "1")));
  check("a legacy raw-token row still matches", t.reportTokenMatches(TOKEN, TOKEN));
  check("the admin hint is unchanged for both", t.reportTokenHint(stored) === "…abcd" && t.reportTokenHint(TOKEN) === "…abcd" && t.reportTokenHint(null) === null);
  check("erasure looks for both forms", JSON.stringify(t.reportTokenForms(TOKEN)) === JSON.stringify([stored, TOKEN]));

  const { reportCreator } = await import("@/lib/data/fans");
  const r = await reportCreator(TOKEN, "predatory", "detail");
  const row = inserts.find((i) => "reason" in i);
  check("the write path stores the digest, not the token", "ok" in r && !!row && row.token === stored && !JSON.stringify(row).includes(TOKEN));

  console.log(`reportToken.test: ${passed} checks passed`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
