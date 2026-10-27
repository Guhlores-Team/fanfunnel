import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// #26 reward encryption at rest. A reward value (link, text or code) exists in
// plaintext only inside one server request: it is encrypted here before it is
// stored, and decrypted here for the winner's own response. AES-256-GCM with a
// random 12-byte IV per value; the GCM tag is appended to the ciphertext, and
// the creator id is bound in as associated data so a ciphertext can't be moved
// to another creator's prize. Never log a value or the key.

/** Env var holding the key: base64 of exactly 32 random bytes. Server only. */
export const REWARD_KEY_ENV = "REWARD_ENCRYPTION_KEY";
/** Which key `REWARD_ENCRYPTION_KEY` is (bump it when the key is rotated). */
export const REWARD_KEY_VERSION_ENV = "REWARD_ENCRYPTION_KEY_VERSION";

const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface SealedReward {
  cipher: string;
  iv: string;
  keyVersion: number;
}

function currentKeyVersion(): number {
  const raw = process.env[REWARD_KEY_VERSION_ENV];
  const n = raw ? Number(raw) : 1;
  return Number.isInteger(n) && n >= 1 && n <= 32767 ? n : 1;
}

function loadKey(): Buffer | null {
  const raw = process.env[REWARD_KEY_ENV]?.trim();
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  return key.length === 32 ? key : null;
}

/** True when a usable key is configured (32 bytes of base64). */
export function rewardCryptoReady(): boolean {
  return loadKey() !== null;
}

const aad = (creatorId: string) => Buffer.from(`fanfunnel-reward:${creatorId}`, "utf8");

/** Encrypt a reward value for `creatorId`. Throws when no key is configured. */
export function sealReward(plain: string, creatorId: string): SealedReward {
  const key = loadKey();
  if (!key) throw new Error("reward_key_missing");
  const iv = randomBytes(IV_BYTES);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(aad(creatorId));
  const body = Buffer.concat([c.update(plain, "utf8"), c.final(), c.getAuthTag()]);
  return { cipher: body.toString("base64"), iv: iv.toString("base64"), keyVersion: currentKeyVersion() };
}

/**
 * Decrypt a stored reward. Throws on a missing key, a key-version mismatch, a
 * tampered ciphertext or the wrong creator: the caller treats any throw as
 * "can't deliver" and never shows a partial value.
 */
export function openReward(sealed: SealedReward, creatorId: string): string {
  const key = loadKey();
  if (!key) throw new Error("reward_key_missing");
  if (sealed.keyVersion !== currentKeyVersion()) throw new Error("reward_key_version");
  const iv = Buffer.from(sealed.iv, "base64");
  const body = Buffer.from(sealed.cipher, "base64");
  if (iv.length !== IV_BYTES || body.length < TAG_BYTES) throw new Error("reward_cipher_invalid");
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAAD(aad(creatorId));
  d.setAuthTag(body.subarray(body.length - TAG_BYTES));
  return Buffer.concat([d.update(body.subarray(0, body.length - TAG_BYTES)), d.final()]).toString("utf8");
}
