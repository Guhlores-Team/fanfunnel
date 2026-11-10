import assert from "node:assert/strict";
import { mock } from "node:test";

// ATK-01 / TS-05: the creator's own session (or a team member's) cannot act
// as a fan through the fan's link token. Cookie absent → nothing is looked up.

let cookieNames: string[] = [];
let configured = true;
let user: { id: string } | null = { id: "creator-1" };
let canAct = true;
let rpcError: { message: string } | null = null;
const rpcCalls: unknown[] = [];
let passLookups = 0;

mock.module("next/headers", { namedExports: {
  cookies: async () => ({ getAll: () => cookieNames.map((name) => ({ name, value: "x" })) }),
  headers: async () => new Headers(),
} });
mock.module("@/lib/supabase/server", { namedExports: {
  isSupabaseConfigured: () => configured,
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user } }) },
    rpc: async (name: string, args: unknown) => { rpcCalls.push([name, args]); return { data: rpcError ? null : canAct, error: rpcError }; },
  }),
  createServiceClient: () => ({
    from: () => ({ select: () => ({ eq: (_c: string, token: string) => ({ maybeSingle: async () => { passLookups++; return { data: token === "known" ? { creator_id: "creator-1" } : null }; } }) }) }),
  }),
} });
mock.module("@/lib/data/mock", { namedExports: { mockTokenHasCreator: (token: string) => token === "known" } });

let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };

async function main() {
  const { creatorActsForFan, refuseCreatorSession, isSessionCookieName, CREATOR_SESSION_ERROR, GUARD_LIMIT } = await import("./creatorGuard");
  const from = (ip: string) => new Request("http://localhost/api/fans/ack", { method: "POST", headers: { "x-real-ip": ip } });
  check("the Supabase auth cookie is recognised, chunked too", isSessionCookieName("sb-abcdefgh-auth-token") && isSessionCookieName("sb-abcdefgh-auth-token.1"));
  check("other cookies are not a session", !isSessionCookieName("sb-abcdefgh-auth-token-code-verifier") && !isSessionCookieName("ff-theme"));

  cookieNames = ["ff-theme"];
  check("no session cookie: a fan is never refused", !(await creatorActsForFan("known")) && (await refuseCreatorSession(from("192.0.2.1"), "known")) === null);
  check("no session cookie: no lookup at all (zero cost for fans)", passLookups === 0 && rpcCalls.length === 0);

  cookieNames = ["sb-proj-auth-token"];
  check("unknown token with a session: not refused (the route 404s on its own)", !(await creatorActsForFan("nope")));
  check("known token, user can act for the creator: refused", await creatorActsForFan("known"));
  check("the permission comes from can_act_for with the pass's creator, never the client", JSON.stringify(rpcCalls.at(-1)) === JSON.stringify(["can_act_for", { target_creator: "creator-1", perm: "view" }]));
  const refused = await refuseCreatorSession(from("192.0.2.1"), "known");
  const refusal = refused ? await refused.json() : null;
  check("the refusal is a plain 403 with a message", refused !== null && refused.status === 403 && refusal.error === CREATOR_SESSION_ERROR && /signed in as a creator/.test(refusal.message));

  canAct = false;
  check("a signed-in user who cannot act for this creator is a stranger: not refused", !(await creatorActsForFan("known")));
  rpcError = { message: "connection reset" };
  check("a signed-in user whose permission cannot be read is refused (fails closed)", await creatorActsForFan("known"));
  rpcError = null;
  canAct = true;
  user = null;
  check("a stale cookie with no user: not refused", !(await creatorActsForFan("known")));
  user = { id: "creator-1" };

  // The guard answers before the fan's limits, so its own lookups are capped
  // per address (C2), and only for requests that carry a session.
  const before = passLookups;
  let answers: (number | null)[] = [];
  for (let i = 0; i < GUARD_LIMIT.limit + 2; i++) answers.push((await refuseCreatorSession(from("192.0.2.2"), "nope"))?.status ?? null);
  check("a session cookie with unknown tokens passes through until the guard's own budget is spent", answers.slice(0, GUARD_LIMIT.limit).every((a) => a === null));
  check("then that address is refused with 429 before any lookup", answers.slice(GUARD_LIMIT.limit).every((a) => a === 429) && passLookups === before + GUARD_LIMIT.limit);
  const still = await refuseCreatorSession(from("192.0.2.3"), "known");
  check("another address still gets its 403", still?.status === 403);
  cookieNames = [];
  answers = [];
  for (let i = 0; i < 3; i++) answers.push((await refuseCreatorSession(from("192.0.2.2"), "known"))?.status ?? null);
  check("a fan (no cookie) at the spent address is neither refused nor counted", answers.every((a) => a === null) && passLookups === before + GUARD_LIMIT.limit + 1);
  cookieNames = ["sb-proj-auth-token"];

  configured = false;
  check("demo mode: a session cookie is the demo creator, who owns every demo fan", await creatorActsForFan("known") && !(await creatorActsForFan("nope")));
  console.log(`creatorGuard: ${passed} checks passed`);
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
