import type { Instrumentation } from "next";

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
