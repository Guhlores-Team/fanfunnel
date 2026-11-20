import "server-only";
import { createHmac } from "node:crypto";

/** Demo consumed-code tombstones keep a keyed identity, never the code text. */
export function demoCodeFingerprint(key: Buffer, prizeId: string, code: string): string {
  return createHmac("sha256", key).update(JSON.stringify(["demo", prizeId, code])).digest("hex");
}
