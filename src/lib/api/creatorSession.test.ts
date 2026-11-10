import assert from "node:assert/strict";
import { mock } from "node:test";

// ATK-01 (widened), NEGATIVE: a creator's own session, or a seat that can act
// for that creator, cannot perform a fan's consent-type action with the fan's
// token; another creator, a signed-out browser and a fan (no cookie) are not
// affected. The role source is the session user id + can_act_for() (server).
let user: { id: string } | null = null;
let canAct = false;
let clients = 0;
const rpcs: { name: string; args: Record<string, unknown> }[] = [];
mock.module("@/lib/supabase/server", { namedExports: {
  isSupabaseConfigured: () => true,
  createClient: async () => { clients++; return { auth: { getUser: async () => ({ data: { user } }) }, rpc: async (name: string, args: Record<string, unknown>) => { rpcs.push({ name, args }); return { data: canAct, error: null }; } }; },
  createServiceClient: () => { throw new Error("the fan refusal never needs the service key"); },
} });
let passed = 0;
const check = (label: string, ok: unknown) => { assert.ok(ok, label); passed++; };
const CREATOR = "00000000-0000-4000-8000-000000000c01";
const COOKIE = "sb-abcdefgh-auth-token=base64-eyJhbGciOi";

async function main() {
  const { refuseCreatorActingAsFan } = await import("./creatorSession");
  const req = (cookie?: string) => new Request("http://x/api/fans/ack", { method: "POST", headers: cookie ? { cookie } : {} });
  check("a fan (no session cookie) is never looked up", (await refuseCreatorActingAsFan(req(), CREATOR)) === null && clients === 0);
  user = { id: CREATOR };
  const refused = await refuseCreatorActingAsFan(req(COOKIE), CREATOR);
  check("NEGATIVE: the creator's own session is refused 403 creator_session, uncached", refused?.status === 403 && (await refused.json()).error === "creator_session" && refused.headers.get("cache-control") === "no-store");
  user = { id: "00000000-0000-4000-8000-000000000c02" }; canAct = true;
  const seat = await refuseCreatorActingAsFan(req(COOKIE), CREATOR);
  check("NEGATIVE: a seat that can act for the creator is refused too", seat?.status === 403 && rpcs.at(-1)?.name === "can_act_for" && rpcs.at(-1)?.args.target_creator === CREATOR);
  canAct = false;
  check("an unrelated creator's session is not refused (the token stays the authority)", (await refuseCreatorActingAsFan(req(COOKIE), CREATOR)) === null);
  user = null;
  check("a stale/invalid session cookie is not refused", (await refuseCreatorActingAsFan(req(COOKIE), CREATOR)) === null);
  check("role decisions never read user_metadata / app_metadata", !/user_metadata|app_metadata/.test((await import("node:fs")).readFileSync(new URL("./creatorSession.ts", import.meta.url), "utf8")));
  console.log(`creator session refusal: ${passed} checks passed`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
