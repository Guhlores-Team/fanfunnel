import assert from "node:assert";
import { mock } from "node:test";

// AUTH-SENSITIVE (AGENTS.md rules 5/7): POST /api/agency/leave. org_leave
// (0071) acts on the caller's own seat and membership only (auth.uid() in
// SQL), so the route's job is to validate and dispatch with the caller's own
// session client, never the service role. Negative tests: a malformed body or
// a non-UUID org never reaches the RPC; the body cannot name another account;
// a refusal from SQL is passed on, not turned into success. The SQL half
// (own rows only, anon refused, not_member) is in
// scripts/db/ledgerGuardsProbe.mjs and scripts/security/rls-runtime-test.mjs.

const ORG = "0a0a0a0a-0000-4000-8000-00000000000a";
const calls: { name: string; args: Record<string, unknown> }[] = [];
let answer: { data: unknown; error: unknown } = { data: "ok", error: null };
let serviceUsed = false;

mock.module("@/lib/supabase/server", { namedExports: {
  isSupabaseConfigured: () => true,
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u" } }, error: null }) },
    rpc: async (name: string, args: Record<string, unknown>) => { calls.push({ name, args }); return answer; },
  }),
  createServiceClient: () => { serviceUsed = true; throw new Error("the leave route must never use the service role"); },
} });
mock.module("@/lib/api/limit", { namedExports: { rateLimitOr429: async () => null, limitRoute: async () => null } });

let checks = 0;
const check = (label: string, condition: unknown) => { assert.ok(condition, label); checks++; };
const post = (body: string) => new Request("http://localhost/api/agency/leave", { method: "POST", headers: { "Content-Type": "application/json" }, body });

async function main() {
  const { POST } = await import("./route");

  for (const [label, body] of [["not JSON", "{"], ["an array", "[]"], ["a string", "\"x\""], ["no org", "{}"], ["a non-UUID org", JSON.stringify({ orgId: "abc" })], ["a numeric org", JSON.stringify({ orgId: 7 })]] as const) {
    const res = await POST(post(body));
    check(`${label} is a 400`, res.status === 400);
  }
  check("no malformed request reached org_leave", calls.length === 0);

  const left = await POST(post(JSON.stringify({ orgId: ORG, profileId: "another-account", userId: "x" })));
  check("a valid org leaves with 200", left.status === 200 && (await left.json()).ok === true);
  check("org_leave gets the org and nothing that names an account", calls.length === 1 && calls[0].name === "org_leave" && JSON.stringify(calls[0].args) === JSON.stringify({ p_org: ORG }));

  answer = { data: "not_member", error: null };
  const notMember = await POST(post(JSON.stringify({ orgId: ORG })));
  check("not_member is passed on as an error, never success", notMember.status >= 400 && (await notMember.json()).error === "not_member");

  answer = { data: null, error: { code: "42501", message: "permission denied" } };
  const refused = await POST(post(JSON.stringify({ orgId: ORG })));
  check("an SQL refusal is an error response", refused.status >= 400);
  check("the service role is never used", !serviceUsed);

  console.log(`agency leave route: ${checks} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
