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
  const { creatorActsForFan, refuseCreatorSession, isSessionCookieName, CREATOR_SESSION_ERROR } = await import("./creatorGuard");
  check("the Supabase auth cookie is recognised, chunked too", isSessionCookieName("sb-abcdefgh-auth-token") && isSessionCookieName("sb-abcdefgh-auth-token.1"));
  check("other cookies are not a session", !isSessionCookieName("sb-abcdefgh-auth-token-code-verifier") && !isSessionCookieName("ff-theme"));

  cookieNames = ["ff-theme"];
  check("no session cookie: a fan is never refused", !(await creatorActsForFan("known")) && (await refuseCreatorSession("known")) === null);
  check("no session cookie: no lookup at all (zero cost for fans)", passLookups === 0 && rpcCalls.length === 0);

  cookieNames = ["sb-proj-auth-token"];
  check("unknown token with a session: not refused (the route 404s on its own)", !(await creatorActsForFan("nope")));
  check("known token, user can act for the creator: refused", await creatorActsForFan("known"));
  check("the permission comes from can_act_for with the pass's creator, never the client", JSON.stringify(rpcCalls.at(-1)) === JSON.stringify(["can_act_for", { target_creator: "creator-1", perm: "view" }]));
  const refused = await refuseCreatorSession("known");
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

  configured = false;
  check("demo mode: a session cookie is the demo creator, who owns every demo fan", await creatorActsForFan("known") && !(await creatorActsForFan("nope")));
  console.log(`creatorGuard: ${passed} checks passed`);
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
