import { creatorRequestResolved, readCreatorRequestResult, type CreatorRequestKind, type CreatorRequestStatus } from "@/lib/creatorRequests";
import { completeCreatorIntent, readCreatorIntent, type IntentStorage } from "./creatorIntent";
export type { CreatorRequestKind, CreatorRequestStatus } from "@/lib/creatorRequests";
export type TerminalCreatorRequestStatus = "committed" | "cancelled" | "rejected" | "gone";

/** A status for another operation must never release this local retry receipt. */
export function creatorRequestOutcome(value: unknown, requestId: string, kind: CreatorRequestKind): CreatorRequestStatus {
  const result = readCreatorRequestResult(value, requestId, kind);
  if (!result) throw new Error("outcome_unconfirmed");
  return result.status;
}
export const terminalCreatorRequest = (status: CreatorRequestStatus): status is TerminalCreatorRequestStatus => creatorRequestResolved(status);

/** A late result cannot clear another form's newer receipt. */
export function releaseCreatorRequest(storage: IntentStorage, scope: string, value: unknown, requestId: string, kind: CreatorRequestKind): CreatorRequestStatus {
  const status = creatorRequestOutcome(value, requestId, kind);
  if (terminalCreatorRequest(status)) {
    if (readCreatorIntent(storage, scope)?.id !== requestId) throw new Error("receipt_changed");
    completeCreatorIntent(storage, scope, requestId);
  }
  return status;
}
