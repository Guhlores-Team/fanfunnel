"use client";
import { completeCreatorIntent, durableCreatorIntent } from "./creatorIntent";
type Storage = Parameters<typeof durableCreatorIntent>[0];
type ImportBody = { batchId: string; rows: readonly Record<string, unknown>[] };
type Reply = { ok: boolean; json(): Promise<unknown> };
export type ImportSubmission = { status: "confirmed"; batchId: string; created: number; failed: number; replayed: boolean } | { status: "pending" };

/** Storage contains only an opaque operation UUID and digest. Every uncertain
 * outcome retains that binding; even a later403 cannot disprove an old commit. */
export async function submitFanImport(storage: Storage, scope: string, rows: readonly Record<string, unknown>[], send: (body: ImportBody) => Promise<Reply>): Promise<ImportSubmission> {
  const intentScope = `fan-import:${scope}`;
  try {
    const batchId = await durableCreatorIntent(storage, intentScope, { rows });
    const response = await send({ batchId, rows });
    if (!response.ok) return { status: "pending" };
    const value = await response.json();
    if (!value || typeof value !== "object") return { status: "pending" };
    const data = value as Record<string, unknown>;
    if (data.batchId !== batchId || typeof data.replayed !== "boolean" || typeof data.created !== "number" || typeof data.failed !== "number" || !Number.isInteger(data.created) || !Number.isInteger(data.failed) || data.created < 0 || data.failed < 0 || data.created + data.failed !== rows.length || !Array.isArray(data.results) || data.results.length !== rows.length) return { status: "pending" };
    const errors = data.results.filter(row => row && typeof row === "object" && typeof row.error === "string").length;
    if (errors !== data.failed || !data.results.every(row => row && typeof row === "object" && (typeof row.error === "string" || typeof row.token === "string"))) return { status: "pending" };
    completeCreatorIntent(storage, intentScope, batchId);
    return { status: "confirmed", batchId, created: data.created, failed: data.failed, replayed: data.replayed };
  } catch { return { status: "pending" }; }
}
