import "server-only";
import type { CreatorRequestKind, CreatorRequestResult } from "@/lib/creatorRequests";
export interface MockCreatorRequest {
  requestId: string; kind: CreatorRequestKind; hash: string | null;
  status: "pending" | "committed" | "cancelled" | "rejected" | "gone";
  fanId?: string; passId?: string; grantId?: string; batchId?: string;
  createdAt: string; finishedAt?: string;
}
const globalJournal = globalThis as unknown as { __ffCreatorRequests?: Map<string, MockCreatorRequest> };
export const mockCreatorRequests = (): Map<string, MockCreatorRequest> => globalJournal.__ffCreatorRequests ??= new Map();
export function beginMockCreatorRequest(requestId: string, kind: CreatorRequestKind, hash: string, refs: Pick<MockCreatorRequest, "fanId" | "passId" | "grantId" | "batchId"> = {}): "ready" | "committed" | "cancelled" | "rejected" | "gone" | "conflict" {
  requestId = requestId.toLowerCase();
  const journal = mockCreatorRequests(), previous = journal.get(requestId);
  if (previous) {
    if (previous.kind !== kind || (previous.hash !== null && previous.hash !== hash)) return "conflict";
    return previous.status === "pending" ? "ready" : previous.status;
  }
  journal.set(requestId, { requestId, kind, hash, status: "pending", ...refs, createdAt: new Date().toISOString() });
  return "ready";
}
export function finishMockCreatorRequest(requestId: string, status: "committed" | "rejected", refs: Pick<MockCreatorRequest, "fanId" | "passId" | "grantId" | "batchId"> = {}): boolean {
  requestId = requestId.toLowerCase();
  const entry = mockCreatorRequests().get(requestId);
  if (!entry || entry.status !== "pending") return false;
  Object.assign(entry, refs, { status, finishedAt: new Date().toISOString() });
  return true;
}
export function reconcileMockCreatorRequest(requestId: string, kind: CreatorRequestKind, cancel: boolean): CreatorRequestResult {
  requestId = requestId.toLowerCase();
  const journal = mockCreatorRequests(); let entry = journal.get(requestId);
  if (entry && entry.kind !== kind) return { requestId, kind, status: "conflict", authorized: true };
  if (cancel && (!entry || entry.status === "pending")) {
    entry = { requestId, kind, hash: entry?.hash ?? null, status: "cancelled", createdAt: entry?.createdAt ?? new Date().toISOString(), finishedAt: new Date().toISOString() };
    journal.set(requestId, entry);
  }
  return { requestId, kind, status: entry?.status ?? "absent", authorized: true };
}
export function eraseMockCreatorRequestFan(fanId: string): void {
  for (const entry of mockCreatorRequests().values()) if (entry.fanId === fanId) {
    entry.status = "gone"; entry.finishedAt = new Date().toISOString();
    delete entry.fanId; delete entry.passId; delete entry.grantId;
  }
}

/** Clearing business data must still fence delayed requests from before the reset. */
export function resetMockCreatorRequestBusinessData(): void {
  for (const entry of mockCreatorRequests().values()) {
    if (entry.status === "committed") entry.status = "gone";
    if (entry.status === "pending") entry.status = "cancelled";
    entry.finishedAt ??= new Date().toISOString();
    delete entry.fanId; delete entry.passId; delete entry.grantId; delete entry.batchId;
  }
}
