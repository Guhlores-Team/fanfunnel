import assert from "node:assert";
import { mock } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// TS-05 (0073): the age/terms acknowledgement keeps keyed digests of the
// address and browser it came from, never the values, and is written through
// record_fan_ack (service role), whose table only admins can read.

let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };

let key: Buffer | null = Buffer.from("k".repeat(32));
mock.module("@/lib/rewards/crypto", { namedExports: { claimCodeKey: () => key } });

type Rpc = { name: string; args: Record<string, unknown> };
const rpcs: Rpc[] = [];
const updates: Record<string, unknown>[] = [];
let rpcResult: { data: unknown; error: { code?: string } | null } = { data: { status: "ok" }, error: null };
let pass: Record<string, unknown> | null = { creator_id: "c1", campaign_id: null, wheel_id: "w1", pinned_wheel_id: null, fan_id: "f1", expires_at: null, fan: { blocked_at: null, acked_at: null, acked_terms_version: null } };
const chain = (result: unknown) => { const q: Record<string, unknown> = {}; for (const m of ["select", "eq", "is", "lte", "gte", "or", "order", "limit", "in", "not"]) q[m] = () => q; q.maybeSingle = async () => result; q.then = (ok: (v: unknown) => unknown) => Promise.resolve(result).then(ok); return q; };
mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => true,
    createClient: async () => { throw new Error("the fan ack never uses a session client"); },
    createServiceClient: () => ({
      from: (table: string) => table === "fan_passes" ? chain({ data: pass, error: null })
        : table === "fans" ? { update: (row: Record<string, unknown>) => { updates.push(row); return chain({ data: null, error: null }); }, ...(chain({ data: null, error: null }) as object) }
        // The creator's one live wheel (list read), also answering the by-id read.
        : table === "wheels" ? (() => { const q = chain({ data: [{ id: "w1", is_active: true, active_from: null, active_until: null, created_at: "2026-01-01T00:00:00Z", game_kind: "wheel", game_ready: true }], error: null }); q.maybeSingle = async () => ({ data: { id: "w1", archived_at: null, game_kind: "wheel", game_ready: true }, error: null }); return q; })()
        : chain({ data: null, error: null }),
      rpc: async (name: string, args: Record<string, unknown>) => { rpcs.push({ name, args }); return name === "record_fan_ack" ? rpcResult : { data: null, error: null }; },
    }),
  },
});

const HEX = /^[a-f0-9]{64}$/;

async function main() {
  const { consentEvidence, consentEvidenceFor } = await import("./consentEvidence");
  const a = consentEvidenceFor("203.0.113.7", "Mozilla/5.0 (iPhone)");
  check("both digests are 64 hex (the SQL CHECK)", HEX.test(a.ipHash ?? "") && HEX.test(a.uaHash ?? ""));
  check("the raw values are not in the digests", !JSON.stringify(a).includes("203.0.113.7") && !JSON.stringify(a).includes("Mozilla"));
  check("stable for the same input", JSON.stringify(consentEvidenceFor("203.0.113.7", "Mozilla/5.0 (iPhone)")) === JSON.stringify(a));
  check("different addresses differ", consentEvidenceFor("203.0.113.8", "Mozilla/5.0 (iPhone)").ipHash !== a.ipHash);
  check("the ip and ua digests are domain-separated", consentEvidenceFor("x", "x").ipHash !== consentEvidenceFor("x", "x").uaHash);
  check("an unknown address or empty browser string is null, not a digest of nothing", consentEvidenceFor("local", "").ipHash === null && consentEvidenceFor(null, "  ").uaHash === null);
  check("a huge user agent is cut before hashing", consentEvidenceFor("1.1.1.1", "a".repeat(600)).uaHash === consentEvidenceFor("1.1.1.1", "a".repeat(512)).uaHash);
  const keyed = a.ipHash;
  key = null;
  const bare = consentEvidenceFor("203.0.113.7", "Mozilla/5.0 (iPhone)");
  check("without a key the digest still never stores the value", HEX.test(bare.ipHash ?? "") && bare.ipHash !== keyed);
  key = Buffer.from("k".repeat(32));
  const fromReq = consentEvidence(new Request("https://x.test/api/fans/ack", { method: "POST", headers: { "x-real-ip": "203.0.113.7", "user-agent": "Mozilla/5.0 (iPhone)" } }));
  check("the request's own address and browser are used", fromReq.ipHash === a.ipHash && fromReq.uaHash === a.uaHash);

  const { ackFan } = await import("@/lib/data/fans");
  check("the ack is written through record_fan_ack with the digests", JSON.stringify(await ackFan("tok", a)) === '{"ok":true}'
    && rpcs.some((r) => r.name === "record_fan_ack" && r.args.p_token === "tok" && r.args.p_ip_hash === a.ipHash && r.args.p_ua_hash === a.uaHash));
  check("no direct fans update when the RPC answers", updates.length === 0);
  rpcs.length = 0;
  await ackFan("tok");
  check("no evidence is null, never an empty string", rpcs.some((r) => r.name === "record_fan_ack" && r.args.p_ip_hash === null && r.args.p_ua_hash === null));
  rpcResult = { data: { status: "not_found" }, error: null };
  check("the RPC's not_found is not_found", JSON.stringify(await ackFan("tok", a)) === '{"error":"not_found"}');
  rpcResult = { data: null, error: { code: "57014" } };
  check("a failed RPC is db_error and stamps nothing", JSON.stringify(await ackFan("tok", a)) === '{"error":"db_error"}' && updates.length === 0);
  rpcResult = { data: null, error: { code: "PGRST202" } };
  check("a database before 0073 keeps the gate working with the plain stamp", JSON.stringify(await ackFan("tok", a)) === '{"ok":true}' && updates.length === 1 && typeof updates[0].acked_terms_version === "string");
  rpcResult = { data: { status: "ok" }, error: null };
  pass = { ...pass!, expires_at: "2000-01-01T00:00:00Z" };
  rpcs.length = 0;
  check("an expired link cannot be acknowledged (PR-13)", JSON.stringify(await ackFan("tok", a)) === '{"error":"not_found"}' && !rpcs.some((r) => r.name === "record_fan_ack"));
  pass = null;
  check("an unknown link is not_found before any write", JSON.stringify(await ackFan("nope", a)) === '{"error":"not_found"}' && !rpcs.some((r) => r.name === "record_fan_ack"));

  const root = join(__dirname, "..", "..", "..");
  const route = readFileSync(join(root, "src/app/api/fans/ack/route.ts"), "utf8");
  check("the route refuses a creator session before it records anything", route.indexOf("refuseCreatorSession(body.token)") > 0 && route.indexOf("refuseCreatorSession(body.token)") < route.indexOf("ackFan(body.token, consentEvidence(req))"));
  const src = readFileSync(join(root, "src/lib/fan/consentEvidence.ts"), "utf8");
  check("the evidence module is server-only", src.startsWith('import "server-only";'));
  console.log(`consentEvidence.test: ${passed} checks passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
