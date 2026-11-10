import assert from "node:assert/strict";
import { mock } from "node:test";

// PR-10 authorization (AGENTS.md rules 3, 5, 6): the delivery promise is the
// one profile column a creator sets through the server. The service role
// writes it only after the caller's own session proved can_act_for(self,
// 'manage'), only on the caller's own row, only as 1..60 or null. A creator
// can never reach another column or another row through this path.
// CC-06: Set active flags the chosen game before clearing the others.

let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };

const me = "00000000-0000-4000-8000-0000000000d1";
let signedIn = true;
let canManage: unknown = true;
let columnExists = true;
const sessionWrites: string[] = [];
const serviceWrites: { table: string; payload: Record<string, unknown>; filters: [string, unknown][] }[] = [];
const wheelWrites: { payload: Record<string, unknown>; filters: [string, string, unknown][] }[] = [];

function session() {
  return {
    auth: { getUser: async () => ({ data: { user: signedIn ? { id: me } : null }, error: null }) },
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "can_act_for") return { data: args.target_creator === me ? canManage : false, error: null };
      throw new Error(`unexpected session rpc ${name}`);
    },
    from: (table: string) => {
      if (table === "wheels") {
        const filters: [string, string, unknown][] = [];
        let payload: Record<string, unknown> | null = null;
        const q = {
          select: () => q,
          update: (p: Record<string, unknown>) => { payload = p; return q; },
          eq: (c: string, v: unknown) => { filters.push(["eq", c, v]); return q; },
          neq: (c: string, v: unknown) => { filters.push(["neq", c, v]); return q; },
          maybeSingle: async () => ({ data: { id: "w2", game_ready: true }, error: null }),
          then: (res: (v: unknown) => unknown) => { if (payload) wheelWrites.push({ payload, filters }); return Promise.resolve({ data: null, error: null }).then(res); },
        };
        return q;
      }
      sessionWrites.push(table);
      throw new Error(`the session must not touch ${table} here`);
    },
  };
}
function service() {
  return {
    from: (table: string) => ({
      update: (payload: Record<string, unknown>) => {
        const filters: [string, unknown][] = [];
        const q = {
          eq: (c: string, v: unknown) => { filters.push([c, v]); return q; },
          then: (res: (v: unknown) => unknown) => {
            serviceWrites.push({ table, payload, filters });
            return Promise.resolve({ data: null, error: columnExists ? null : { code: "PGRST204", message: "Could not find the 'delivery_days' column" } }).then(res);
          },
        };
        return q;
      },
    }),
  };
}
mock.module("@/lib/supabase/server", { namedExports: { isSupabaseConfigured: () => true, createClient: async () => session(), createServiceClient: () => service() } });

async function main() {
  const { setMyPublicProfile } = await import("./publicProfile");

  let result = await setMyPublicProfile({ deliveryDays: 5 });
  check("an active creator saves its own promise", "ok" in result && serviceWrites.length === 1);
  const write = serviceWrites[0];
  check("the service write is the one column, on the caller's own row", write.table === "profiles" && JSON.stringify(write.payload) === '{"delivery_days":5}' && JSON.stringify(write.filters) === JSON.stringify([["id", me]]));
  result = await setMyPublicProfile({ deliveryDays: null });
  check("null clears the promise", "ok" in result && serviceWrites.at(-1)?.payload.delivery_days === null);

  // Negative: no proof on the session, no service write.
  canManage = false;
  let before = serviceWrites.length;
  result = await setMyPublicProfile({ deliveryDays: 7 });
  check("a session that fails can_act_for (suspended, unapproved) is refused before the service role is used", "error" in result && result.error === "forbidden" && serviceWrites.length === before);
  canManage = "true";
  result = await setMyPublicProfile({ deliveryDays: 7 });
  check("only a literal true passes the permission check", "error" in result && result.error === "forbidden" && serviceWrites.length === before);
  canManage = true;
  signedIn = false;
  result = await setMyPublicProfile({ deliveryDays: 7 });
  check("signed out: refused, nothing written", "error" in result && serviceWrites.length === before);
  signedIn = true;

  for (const bad of [0, 61, 2.5, -3, Number.NaN]) {
    before = serviceWrites.length;
    result = await setMyPublicProfile({ deliveryDays: bad });
    check(`an out-of-range value (${bad}) never reaches the database`, "error" in result && result.error === "invalid_delivery_days" && serviceWrites.length === before);
  }
  // A caller cannot smuggle another column or row through the input object.
  result = await setMyPublicProfile({ deliveryDays: 3, role: "admin", id: "someone-else", features: { bingo: true } } as never);
  const last = serviceWrites.at(-1)!;
  check("extra keys are ignored: still one column, still the caller's row", "ok" in result && Object.keys(last.payload).join() === "delivery_days" && JSON.stringify(last.filters) === JSON.stringify([["id", me]]));

  columnExists = false;
  result = await setMyPublicProfile({ deliveryDays: 3 });
  check("before the column exists the answer is not_supported", "error" in result && result.error === "not_supported");
  columnExists = true;
  check("the session itself never wrote profiles", sessionWrites.length === 0);

  // CC-06
  const { setActiveWheel } = await import("./wheels");
  wheelWrites.length = 0;
  const switched = await setActiveWheel("w2");
  check("Set active flags the chosen game first, then clears only the others", "ok" in switched && wheelWrites.length === 2
    && wheelWrites[0].payload.is_active === true && wheelWrites[0].filters.some(([op, c, v]) => op === "eq" && c === "id" && v === "w2")
    && wheelWrites[1].payload.is_active === false && wheelWrites[1].filters.some(([op, c, v]) => op === "neq" && c === "id" && v === "w2")
    && wheelWrites.every((w) => w.filters.some(([op, c, v]) => op === "eq" && c === "creator_id" && v === me)));

  console.log(`deliveryDaysWrite.test: ${passed} checks passed`);
}
main().catch((error) => { console.error(error); process.exit(1); });
