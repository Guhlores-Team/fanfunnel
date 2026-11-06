import { after } from "next/server";

/**
 * Run best-effort side work (webhook fan-out, …) after the response is sent,
 * through Next's `after()`: on a serverless host that keeps the invocation
 * alive until `task` settles, where a dangling promise could be frozen
 * mid-flight once the response went out. `task` must not throw; failures are
 * swallowed either way so they never surface on the request.
 *
 * `after()` throws outside a request scope (unit tests, scripts). There is no
 * response to outlive there, so the task just runs in the background.
 */
export function runAfterResponse(task: () => Promise<unknown>): void {
  const run = () => task().then(() => undefined, () => undefined);
  try {
    after(run);
  } catch {
    void run();
  }
}
