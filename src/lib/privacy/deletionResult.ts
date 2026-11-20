/** Only an explicit final acknowledgement may remove an account from the UI. */
export function deletionResponseState(status: number, body: unknown): "complete" | "pending" | "failed" {
  const value = body && typeof body === "object" ? body as Record<string, unknown> : {};
  if (status === 202 || value.pending === true) return "pending";
  return status === 200 && value.ok === true ? "complete" : "failed";
}

export const ACCOUNT_CLEANUP_PENDING_MESSAGE = "Account cleanup or confirmation is still pending. The account has not been confirmed deleted, and access may remain paused until cleanup finishes. An administrator can check and retry cleanup.";
