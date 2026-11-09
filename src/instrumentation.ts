import type { Instrumentation } from "next";

// A bounded runtime self-check runs once per Node server. Builds and mock mode
// perform no database or alert I/O (see operations/startup.ts).
// OPS-14: Next waits for register() before serving the first request, so the
// check is started, not awaited: a slow database must not hold up the first
// fan on a fresh instance. Its own deadline still bounds the work.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  const { registerOperationalChecks } = await import("@/lib/operations/startup");
  void registerOperationalChecks().catch(() => undefined);
}

// Server errors (route handlers, server components, server actions, proxy)
// → app_errors, redacted, with an e-mail alert after the response. Node.js
// runtime only: the store uses the service-role client.
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { captureServerError } = await import("@/lib/monitoring/capture");
    await captureServerError(err, request, context);
  } catch {
    /* monitoring must never break a request */
  }
};
