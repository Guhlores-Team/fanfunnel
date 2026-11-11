"use client";

import type { CreatorRequestKind } from "./creatorRequestOutcome";

export type CreatorReceiptRequest = (request: { requestId: string; kind: CreatorRequestKind; cancel: boolean; creatorId?: string }) => Promise<Response>;
/** Authentication, authorization and the cancellation fence live on the server. */
export const requestCreatorReceipt: CreatorReceiptRequest = ({ requestId, kind, cancel, creatorId }) => {
  const path = `/api/creator-requests/${encodeURIComponent(requestId)}`;
  if (cancel) return fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, ...(creatorId ? { creatorId } : {}) }), cache: "no-store" });
  const query = new URLSearchParams({ kind, ...(creatorId ? { creatorId } : {}) });
  return fetch(`${path}?${query}`, { cache: "no-store" });
};
