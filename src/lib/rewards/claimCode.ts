import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { isSupabaseConfigured } from "@/lib/supabase/server";
import { claimCodeKey } from "./crypto";

// C4 (batch 6 attack audit): the win card's "claim code" used to be the last
// six characters of the share id, which the fan is invited to post publicly,
// so anyone could forge a claim screenshot. It is now a server-side HMAC of
// the share id (a key derived from REWARD_CODE_FINGERPRINT_KEY, crypto.ts):
// 6 Crockford base32 characters, shown only in the winning fan's own spin
// response and checkable by the creator on /verify/<share id>.
//
// What it proves: that whoever shows it held the fan's win page (or was told
// the code by its holder). It does not prove who that person is.

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CLAIM_CODE_LENGTH = 6;
// The demo has no keys and no real accounts; production refuses demo mode.
const DEMO_KEY = Buffer.from("fanfunnel-demo-claim-code-key-not-secret");

function key(): Buffer | null {
  return claimCodeKey() ?? (isSupabaseConfigured() ? null : DEMO_KEY);
}

/** Pure: the code for a share id under a key. */
export function claimCodeWith(k: Buffer, shareId: string): string {
  const mac = createHmac("sha256", k).update(`fanfunnel-claim-code-v1:${shareId}`).digest();
  let bits = mac.readUInt32BE(0);
  let out = "";
  for (let i = 0; i < CLAIM_CODE_LENGTH; i++) {
    out += ALPHABET[bits & 31];
    bits >>>= 5;
  }
  return out;
}

/** The claim code for a share id, or null when no key is configured. */
export function claimCodeFor(shareId: string | null | undefined): string | null {
  if (typeof shareId !== "string" || !shareId) return null;
  const k = key();
  return k ? claimCodeWith(k, shareId) : null;
}

/** Crockford reading: case, spaces and dashes ignored; O→0, I/L→1. */
export function normalizeClaimCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
}

/** Constant-time check of a code a creator typed. False without a key. */
export function verifyClaimCode(shareId: string, input: unknown): boolean {
  if (typeof input !== "string") return false;
  const want = claimCodeFor(shareId);
  const got = normalizeClaimCode(input);
  if (!want || got.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

/** Add `claimCode` to a spin result that carries the winner's share id. */
export function withClaimCode<T>(result: T): T {
  const r = result as { shareId?: unknown } | null;
  if (!r || typeof r !== "object" || typeof r.shareId !== "string") return result;
  const code = claimCodeFor(r.shareId);
  return code ? ({ ...r, claimCode: code } as T) : result;
}
