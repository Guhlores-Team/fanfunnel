"use client";

import { useEffect } from "react";
import { reportClientError } from "@/lib/monitoring/client";
import { reportError as reportToDebugConsole } from "@/components/debug/debug";

/**
 * Report an error caught by a Next.js error boundary (error.tsx /
 * global-error.tsx). An error with a `digest` was thrown on the server and is
 * already recorded by instrumentation.ts (the client only sees a generic
 * stand-in), so it is not sent to monitoring twice. The in-app debug console
 * (a no-op unless debug mode is active) gets every one.
 */
export function useReportBoundaryError(error: (Error & { digest?: string }) | null | undefined): void {
  useEffect(() => {
    if (!error) return;
    const message = error.message || String(error);
    reportToDebugConsole({ kind: "react", message, stack: error.stack });
    if (!error.digest) reportClientError({ message, stack: error.stack, kind: "react" });
  }, [error]);
}
