import assert from "node:assert";
import { mock } from "node:test";
import { randomBytes } from "node:crypto";

// #26 negative tests for the creator reward routes on the Supabase path.
// Authorization is an explicit can_act_for(creator, 'edit_wheel') (or
// is_admin()) on the caller's own session, for the creator that owns the
// prize's wheel; only then does the service client run a server-only RPC,
// always with that creator's id (never one from the request).

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

process.env.REWARD_ENCRYPTION_KEY = randomBytes(32).toString("base64");
const PRIZE = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";

let user: { id: string } | null = { id: "33333333-3333-4333-8333-333333333333" };
let visible = true;
let canEdit = false;
let admin = false;
let serviceClients = 0;
const sessionCalls: { name: string; args: Record<string, unknown> }[] = [];
const serviceCalls: { name: string; args: Record<string, unknown> }[] = [];

function chain(result: unknown) {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "not", "order", "limit", "in"]) q[m] = () => q;
  q.maybeSingle = async () => ({ data: result, error: null });
  q.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [], count: 0, error: null }).then(res);
  return q;
}
const session = {
  auth: { getUser: async () => ({ data: { user }, error: null }) },
  from: () => chain(visible ? { id: PRIZE, delivery: "manual", wheel: { creator_id: OWNER } } : null),
  rpc: async (name: string, args: Record<string, unknown> = {}) => { sessionCalls.push({ name, args }); return { data: name === "can_act_for" ? canEdit : name === "is_admin" ? admin : null, error: null }; },
};
const service = {
  from: () => chain({ delivery: "link", stock: null }),
  rpc: async (name: string, args: Record<string, unknown>) => {
    serviceCalls.push({ name, args });
    return { data: 1, error: null };
  },
};
mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => true,
    createClient: async () => session,
    createServiceClient: () => { serviceClients++; return service; },
  },
});

async function main() {
  const { GET, PUT } = await import("./[id]/reward/route");
  const { POST } = await import("./[id]/codes/route");
  const put = (id: string, body: unknown) =>
    PUT(new Request("http://x/api", { method: "PUT", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
  const codes = (id: string, c: string) =>
    POST(new Request("http://x/api", { method: "POST", body: JSON.stringify({ codes: c }) }), { params: Promise.resolve({ id }) });
  const get = (id: string) => GET(new Request("http://x/api"), {params: Promise.resolve({id})});
  const link = { kind: "link", value: "https://example.com/x", creatorId: "forged-owner", role: "admin" };

  user = null;
  check("signed out: 401", (await put(PRIZE, link)).status === 401);
  check("signed out GET cannot read a reward", (await get(PRIZE)).status === 401);
  check("signed out code upload is401", (await codes(PRIZE, "ABCDEFGH-1")).status === 401);
  user = { id: "33333333-3333-4333-8333-333333333333" };
  check("a non-uuid prize id: 404 before any read", (await put("p123", link)).status === 404);
  visible = false;
  check("a prize RLS hides from the caller: 404", (await put(PRIZE, link)).status === 404);
  visible = true;
  canEdit = false;
  check("another creator's prize (no edit_wheel): 403", (await put(PRIZE, link)).status === 403);
  check("another creator's prize: codes refused too", (await codes(PRIZE, "ABCDEFGH-1")).status === 403);
  check("another creator's prize: GET cannot decrypt its value", (await get(PRIZE)).status === 403);
  check("refused requests never create a service client", serviceClients === 0);
  check("authorization uses the server-resolved prize owner and edit_wheel", sessionCalls.filter((c)=>c.name==="can_act_for").every((c)=>c.args.target_creator===OWNER && c.args.perm==="edit_wheel"));
  check("refused requests never reach a server-only RPC", serviceCalls.length === 0);

  canEdit = true;
  const ok = await put(PRIZE, link);
  check("own prize: 200", ok.status === 200);
  check("own authorized GET is200", (await get(PRIZE)).status === 200);
  const call = serviceCalls.find((c) => c.name === "set_prize_delivery");
  check("the RPC gets the prize owner's id, never the caller's choice", call?.args.p_creator === OWNER && call.args.p_prize === PRIZE);
  check("the link is sent encrypted, never in plaintext", typeof call?.args.p_cipher === "string" && !String(call?.args.p_cipher).includes("example.com"));
  const c = await codes(PRIZE, "ABCDEFGH-1\nIJKLMNOP-2");
  const add = serviceCalls.find((x) => x.name === "add_reward_codes");
  check("codes: 200 and encrypted rows only", c.status === 200 && !JSON.stringify(add?.args).includes("ABCDEFGH"));
  check("codes: only the last-4 hint is kept in clear", JSON.stringify(add?.args).includes('"hint":"GH-1"'));

  canEdit = false;
  admin = true;
  check("an admin may edit", (await put(PRIZE, { kind: "manual" })).status === 200);
  admin = false;

  canEdit = true;
  delete process.env.REWARD_ENCRYPTION_KEY;
  const before = serviceCalls.length;
  const noKey = await put(PRIZE, link);
  check("no key: 503 reward_key_missing, nothing stored", noKey.status === 503 && ((await noKey.json()) as { error: string }).error === "reward_key_missing" && serviceCalls.length === before);
  check("no key: switching back to manual still works", (await put(PRIZE, { kind: "manual" })).status === 200);

  console.log(`rewardAuthz.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
