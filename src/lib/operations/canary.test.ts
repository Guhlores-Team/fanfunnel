import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { sealReward, rewardCodeFingerprint } from "@/lib/rewards/crypto";
import { CANARY_CREATOR, CANARY_PRIZE, CANARY_TEXT } from "./config";
import { verifyStoredCanary, bootstrapEmptyCanary, initializeCanaryForAdmin as initializeWithContext, readCanary } from "./canary";
const fixtureContext = "11111111-1111-4111-8111-111111111111";
const initializeCanaryForAdmin = (...args: Parameters<typeof initializeWithContext>) => initializeWithContext(args[0], args[1], async () => fixtureContext);
import type { createServiceClient } from "@/lib/supabase/server";

let passed = 0;
const check = (label: string, value: unknown) => { assert.ok(value, label); passed++; };
const original = { ...process.env };
const encryption = randomBytes(32).toString("base64"), fingerprint = randomBytes(32).toString("base64");
function keys() { process.env.REWARD_ENCRYPTION_KEY = encryption; process.env.REWARD_CODE_FINGERPRINT_KEY = fingerprint; process.env.REWARD_ENCRYPTION_KEY_VERSION = "1"; }
keys();
const anchor = { ...sealReward(CANARY_TEXT, CANARY_CREATOR), fingerprint: rewardCodeFingerprint(CANARY_TEXT, CANARY_CREATOR, CANARY_PRIZE) };
const calls: { name: string; args?: Record<string, unknown> }[] = [];
function client(replies: ((name: string, args?: Record<string, unknown>) => unknown)[]): ReturnType<typeof createServiceClient> {
  return { rpc: (name: string, args?: Record<string, unknown>) => ({ abortSignal: async () => { calls.push({ name, args }); const reply = replies.shift(); assert.ok(reply, "unexpected RPC"); return reply(name, args); } }) } as unknown as ReturnType<typeof createServiceClient>;
}
const reply = (data: unknown) => () => ({ data, error: null });
async function main() {
  check("real encrypt/decrypt and stable fingerprint validate", verifyStoredCanary(anchor).status === "healthy");
  process.env.REWARD_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  check("same-length wrong AES key fails immutable anchor", verifyStoredCanary(anchor).status === "mismatch"); keys();
  process.env.REWARD_CODE_FINGERPRINT_KEY = randomBytes(32).toString("base64");
  check("same-length wrong independent fingerprint key fails anchor", verifyStoredCanary(anchor).status === "mismatch"); keys();
  process.env.REWARD_ENCRYPTION_KEY_VERSION = "2";
  check("wrong version fails anchor", verifyStoredCanary(anchor).status === "mismatch");
  process.env.REWARD_ENCRYPTION_KEY_VERSION = "bad";
  check("invalid version is distinct", verifyStoredCanary(anchor).status === "configuration_invalid"); keys();
  delete process.env.REWARD_ENCRYPTION_KEY;
  check("missing AES key is distinct", verifyStoredCanary(anchor).status === "configuration_missing"); keys();
  check("missing and unavailable are distinct", verifyStoredCanary(null).status === "missing" && verifyStoredCanary({}).status === "unavailable");
  check("read transport failure is unavailable", (await readCanary(client([() => { throw new Error("synthetic transport error"); }]))).status === "unavailable");
  const empty = await bootstrapEmptyCanary(client([reply(null), (name, args) => {
    check("empty bootstrap uses null actor and empty digest", name === "initialize_reward_crypto_canary" && args?.p_actor === null && args?.p_inventory_digest === createHash("sha256").update("").digest("hex"));
    return { data: { status: "initialized", canary: args?.p_canary }, error: null };
  }]));
  check("empty bootstrap validates returned persisted anchor", empty.status === "healthy" && empty.initialized);
  const guarded = await bootstrapEmptyCanary(client([reply(null), reply({ status: "initialization_required" })]));
  check("startup cannot bless existing inventory", guarded.status === "missing" && !guarded.initialized);
  const wrongAnchor = { ...anchor, fingerprint: "0".repeat(64) };
  const race = await bootstrapEmptyCanary(client([reply(null), reply({ status: "existing", canary: wrongAnchor })]));
  check("first initialization race validates winner and never replaces it", race.status === "mismatch");
  const before = calls.length;
  const known = await initializeCanaryForAdmin(client([reply(wrongAnchor)]), CANARY_CREATOR);
  check("mismatched existing anchor never scans or overwrites", known.status === "mismatch" && calls.length === before + 1);
  const code = "synthetic disposable test value", creator = CANARY_CREATOR, prize = CANARY_PRIZE;
  const sealed = sealReward(code, creator);
  const row = { cursor: `code:${CANARY_PRIZE}`, creator_id: creator, prize_id: prize, cipher: sealed.cipher, iv: sealed.iv, key_version: sealed.keyVersion, fingerprint: rewardCodeFingerprint(code, creator, prize), row_digest: "a".repeat(64) };
  const initialized = await initializeCanaryForAdmin(client([reply(null), reply({ rows: [row] }), (name, args) => {
    check("server binds validated scan to SQL digest", name === "initialize_reward_crypto_canary" && args?.p_inventory_digest === createHash("sha256").update(row.row_digest).digest("hex") && args.p_actor === creator);
    return { data: { status: "initialized", canary: args?.p_canary, inventoryRows: 1 }, error: null };
  }]), creator);
  check("existing code validates decrypt and stable fingerprint", initialized.status === "healthy" && initialized.inventoryRows === 1);
  const invalid = await initializeCanaryForAdmin(client([reply(null), reply({ rows: [{ ...row, fingerprint: "0".repeat(64) }] })]), creator);
  check("wrong existing fingerprint blocks initialization", invalid.status === "mismatch" && invalid.outcome === "validation_failed");
  const unavailable = await initializeCanaryForAdmin(client([reply(null), () => { throw new Error("synthetic transport error"); }]), creator);
  check("inventory transport failure is unavailable, not key mismatch", unavailable.status === "unavailable");
  const changed = await initializeCanaryForAdmin(client([reply(null), reply({ rows: [row] }), reply({ status: "inventory_changed" })]), creator);
  check("SQL inventory CAS race is surfaced without initialization", changed.outcome === "inventory_changed" && !changed.initialized);
  const tombstone = await initializeCanaryForAdmin(client([reply(null), reply({ rows: [] }), reply({ status: "recovery_required" })]), creator);
  check("legacy erased codes require operator recovery", tombstone.outcome === "recovery_required");
  const limit = await initializeCanaryForAdmin(client([reply(null), reply({ status: "inventory_limit", rows: [] })]), creator);
  check("SQL inventory budget is surfaced without blessing empty page", limit.outcome === "inventory_limit" && limit.status === "missing");
  const malformed = await initializeCanaryForAdmin(client([reply(null), reply({ rows: [row, row] })]), creator);
  check("nonmonotone duplicate cursor cannot hide inventory", malformed.status === "unavailable" && malformed.outcome === "unavailable");
  const missingContext = await initializeWithContext(client([reply(null), reply({ rows: [] })]), creator, async () => null);
  check("explicit initialization requires fresh authenticated context after inventory validation", missingContext.outcome === "forbidden");
  const failedContext = await initializeWithContext(client([reply(null), reply({ rows: [] })]), creator, async () => { throw Error("session unavailable"); });
  check("context transport failure is controlled without initializing", failedContext.status === "unavailable" && failedContext.outcome === "unavailable");

  console.log(`operational canary: ${passed} checks passed; all keys and values disposable, no payloads logged`);
}
main().finally(() => { process.env = original; }).catch(error => { console.error(error); process.exitCode = 1; });
