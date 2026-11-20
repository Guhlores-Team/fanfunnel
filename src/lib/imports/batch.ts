/** A normalized, ordered import intent. No credential or browser persistence. */
export const IMPORT_MAX_ROWS = 500;
export const IMPORT_MAX_SPINS = 1_000_000;
export const IMPORT_MAX_AMOUNT_CENTS = 100_000_000;
export type ImportValidationError = "missing_name" | "invalid_spins" | "spins_too_large" | "invalid_amount" | "amount_too_large";
export type ImportRowError = ImportValidationError | "no_wheel" | "campaign_not_found" | "invalid_pack" | "blocked" | "on_break" | "gone";
export interface ImportSlot {
  name: string;
  spins: number;
  amountCents: number;
  campaignId: string | null;
  wheelId: string | null;
  error: ImportValidationError | null;
}
export interface ImportBatchItem { ordinal: number; fanId?: string; passId?: string; grantId?: string; token?: string; error?: ImportRowError }
export type ImportBatchResult = { status: "imported"; batchId: string; replayed: boolean; items: ImportBatchItem[] } | { status: "conflict" | "unavailable" };
function count(value: unknown): number | null {
  if (value == null || value === "") return 0;
  const number = Number(value);
  return Number.isInteger(number) ? Math.max(0, number) : null;
}
/** Preserve the existing import normalization: blank rows fail, negative
 * counts become zero, invalid/over-limit rows never create business records. */
export function normalizeImportRows(rows: unknown[]): ImportSlot[] {
  return rows.map(input => {
    const row = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
    const name = typeof row.name === "string" ? row.name.trim().slice(0, 80) : "";
    const spins = count(row.spins), amount = count(row.amountCents);
    const error: ImportValidationError | null = !name ? "missing_name" : spins === null ? "invalid_spins" : spins > IMPORT_MAX_SPINS ? "spins_too_large" : amount === null ? "invalid_amount" : amount > IMPORT_MAX_AMOUNT_CENTS ? "amount_too_large" : null;
    return { name: name || "(blank)", spins: error ? 0 : spins!, amountCents: error ? 0 : amount!,
      campaignId: !error && typeof row.campaignId === "string" && row.campaignId ? row.campaignId : null,
      wheelId: !error && typeof row.wheelId === "string" && row.wheelId ? row.wheelId : null, error };
  });
}
/** Matches PostgreSQL _canonical_proof_json: lexical keys, array order, exact
 * JSON strings/numbers, no formatting whitespace. Null keys remain explicit. */
export function canonicalImportJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalImportJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalImportJson(entry)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export async function importRequestHash(rows: ImportSlot[]): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalImportJson(["fan-import-v1", rows])));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
