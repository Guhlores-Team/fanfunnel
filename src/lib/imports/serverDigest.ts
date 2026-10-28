import "server-only";
import { createHash } from "node:crypto";
import { canonicalImportJson, type ImportSlot } from "./batch";
/** Synchronous demo transaction validation uses exactly the browser/SQL binding. */
export function serverImportHash(rows: ImportSlot[]): string {
  return createHash("sha256").update(canonicalImportJson(["fan-import-v1", rows])).digest("hex");
}

export function serverCreatorIntentHash(kind: string, value: unknown): string {
  return createHash("sha256").update(canonicalImportJson(["creator-request-v1", kind, value])).digest("hex");
}
