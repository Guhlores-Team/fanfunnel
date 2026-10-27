// Today's "Start win-back" card asks the Analytics win-back card to open its
// queue once it mounts. A one-shot flag in module state: both panels live in
// the same client bundle, so no prop has to thread through DashboardClient.

let pending = false;

export function requestWinbackQueue(): void {
  pending = true;
}

/** True once per request; clears the flag. */
export function takeWinbackQueueRequest(): boolean {
  const was = pending;
  pending = false;
  return was;
}
