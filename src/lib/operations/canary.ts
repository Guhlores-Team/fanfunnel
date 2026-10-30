import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { createServiceClient } from "@/lib/supabase/server";
import { openReward, sealReward, rewardCodeFingerprint, rewardCryptoReady, rewardCodeFingerprintReady, REWARD_KEY_VERSION_ENV } from "@/lib/rewards/crypto";
import { CANARY_CREATOR, CANARY_PRIZE, CANARY_TEXT, DIAGNOSTIC_TIMEOUT_MS, INVENTORY_MAX_ROWS, INVENTORY_PAGE_SIZE, type CanaryResult } from "./config";

type RecordValue = Record<string, unknown>;
const record = (raw: unknown): RecordValue | null => raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw as RecordValue : null;
export function cryptoConfigurationStatus(): "ready" | "configuration_missing" | "configuration_invalid" {
  const version = process.env[REWARD_KEY_VERSION_ENV];
  if (version !== undefined && (!/^[1-9][0-9]{0,4}$/.test(version) || Number(version) > 32767)) return "configuration_invalid";
  return rewardCryptoReady() && rewardCodeFingerprintReady() ? "ready" : "configuration_missing";
}
function same(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function verifyStoredCanary(raw: unknown): CanaryResult {
  const configured = cryptoConfigurationStatus();
  if (configured !== "ready") return { status: configured };
  if (raw === null) return { status: "missing" };
  const row = record(raw);
  if (!row || typeof row.cipher !== "string" || typeof row.iv !== "string" || !Number.isInteger(row.keyVersion) || typeof row.fingerprint !== "string") return { status: "unavailable" };
  try {
    const plain = openReward({ cipher: row.cipher, iv: row.iv, keyVersion: Number(row.keyVersion) }, CANARY_CREATOR);
    return same(plain, CANARY_TEXT) && same(rewardCodeFingerprint(CANARY_TEXT, CANARY_CREATOR, CANARY_PRIZE), row.fingerprint)
      ? { status: "healthy" } : { status: "mismatch" };
  } catch { return { status: "mismatch" }; }
}
export async function readCanary(svc: ReturnType<typeof createServiceClient>): Promise<CanaryResult> {
  const configured = cryptoConfigurationStatus();
  if (configured !== "ready") return { status: configured };
  try {
    const { data, error } = await svc.rpc("read_reward_crypto_canary").abortSignal(AbortSignal.timeout(DIAGNOSTIC_TIMEOUT_MS));
    return error ? { status: "unavailable" } : verifyStoredCanary(data);
  } catch { return { status: "unavailable" }; }
}
function newCanary() {
  return { ...sealReward(CANARY_TEXT, CANARY_CREATOR), fingerprint: rewardCodeFingerprint(CANARY_TEXT, CANARY_CREATOR, CANARY_PRIZE) };
}
export type CanaryInitialization = CanaryResult & { outcome: "initialized" | "existing" | "inventory_changed" | "inventory_limit" | "initialization_required" | "recovery_required" | "forbidden" | "validation_failed" | "unavailable"; inventoryRows?: number };
async function insertCanary(svc: ReturnType<typeof createServiceClient>, digest: string, actor: string | null, context: string | null = null): Promise<CanaryInitialization> {
  const configured = cryptoConfigurationStatus();
  if (configured !== "ready") return { status: configured, outcome: "unavailable" };
  try {
    const { data, error } = await svc.rpc("initialize_reward_crypto_canary", { p_canary: newCanary(), p_inventory_digest: digest, p_actor: actor, p_context: context }).abortSignal(AbortSignal.timeout(DIAGNOSTIC_TIMEOUT_MS));
    const result = record(data);
    if (error || !result || typeof result.status !== "string") return { status: "unavailable", outcome: "unavailable" };
    if (result.status === "initialized" || result.status === "existing") {
      const verified = verifyStoredCanary(result.canary);
      return { ...verified, initialized: result.status === "initialized", outcome: result.status, ...(typeof result.inventoryRows === "number" ? { inventoryRows: result.inventoryRows } : {}) };
    }
    return { status: "missing", outcome: ["inventory_changed", "inventory_limit", "initialization_required", "recovery_required", "forbidden"].includes(result.status) ? result.status as CanaryInitialization["outcome"] : "unavailable" };
  } catch { return { status: "unavailable", outcome: "unavailable" }; }
}
/** Startup can bootstrap only an atomically empty inventory, including tombstones. */
export async function bootstrapEmptyCanary(svc: ReturnType<typeof createServiceClient>): Promise<CanaryResult> {
  const checked = await readCanary(svc);
  if (checked.status !== "missing") return checked;
  const initialized = await insertCanary(svc, createHash("sha256").update("").digest("hex"), null);
  return { status: initialized.status, ...(initialized.initialized ? { initialized: true } : {}) };
}
/** An admin never supplies ciphertext, a key, a digest or inventory rows. Every
 * existing encrypted value is validated here; SQL CAS checks the complete scan. */
export async function initializeCanaryForAdmin(svc: ReturnType<typeof createServiceClient>, actor: string, issueContext?: () => Promise<string | null>): Promise<CanaryInitialization> {
  const checked = await readCanary(svc);
  if (checked.status === "healthy" || checked.status === "mismatch") return { ...checked, outcome: "existing" };
  if (checked.status !== "missing") return { ...checked, outcome: "unavailable" };
  const hash = createHash("sha256"); let after = "", total = 0;
  try {
    for (;;) {
      let response;
      try {
        response = await svc.rpc("reward_crypto_inventory_page", { p_after: after, p_limit: INVENTORY_PAGE_SIZE }).abortSignal(AbortSignal.timeout(DIAGNOSTIC_TIMEOUT_MS));
      } catch { return { status: "unavailable", outcome: "unavailable" }; }
      const { data, error } = response;
      const page = record(data), rows = page?.rows;
      if (!error && page?.status === "inventory_limit") return { status: "missing", outcome: "inventory_limit" };
      if (error || !Array.isArray(rows) || rows.length > INVENTORY_PAGE_SIZE) return { status: "unavailable", outcome: "unavailable" };
      for (const raw of rows) {
        const row = record(raw);
        if (!row || typeof row.cursor !== "string" || row.cursor <= after || !/^(code|reward|spin):[a-f0-9-]{36}$/.test(row.cursor)
          || typeof row.creator_id !== "string" || typeof row.cipher !== "string" || typeof row.iv !== "string" || !Number.isInteger(row.key_version)
          || typeof row.row_digest !== "string" || !/^[a-f0-9]{64}$/.test(row.row_digest)) return { status: "unavailable", outcome: "unavailable" };
        total++; if (total > INVENTORY_MAX_ROWS) return { status: "missing", outcome: "inventory_limit" };
        const plain = openReward({ cipher: row.cipher, iv: row.iv, keyVersion: Number(row.key_version) }, row.creator_id);
        if (row.cursor.startsWith("code:") && (typeof row.prize_id !== "string" || typeof row.fingerprint !== "string" || !same(rewardCodeFingerprint(plain, row.creator_id, row.prize_id), row.fingerprint))) return { status: "mismatch", outcome: "validation_failed" };
        hash.update(row.row_digest); after = row.cursor;
      }
      if (rows.length < INVENTORY_PAGE_SIZE) break;
    }
  } catch { return { status: "mismatch", outcome: "validation_failed" }; }
  // Mint only after the complete bounded inventory scan, so its short TTL is
  // spent at the gateway rather than on decryption/paging. No browser token.
  let context: string | null;
  try { context = issueContext ? await issueContext() : null; }
  catch { return { status: "unavailable", outcome: "unavailable" }; }
  if (!context) return { status: "missing", outcome: "forbidden" };
  return insertCanary(svc, hash.digest("hex"), actor, context);
}
