"use client";

import type { ReactNode } from "react";
import { brandVars, DEFAULT_BRAND } from "@/lib/theme";
import { useReportBoundaryError } from "@/components/monitoring/useReportBoundaryError";

/**
 * The card a route error boundary (error.tsx) shows: reported to error
 * monitoring, a plain explanation and a Try again. Server state is
 * authoritative, so nothing the visitor did is lost by retrying.
 */
export default function RouteErrorView({
  error,
  retry,
  title = "Something went sideways",
  body,
  children,
}: {
  error: Error & { digest?: string };
  retry?: () => void;
  title?: string;
  body: ReactNode;
  children?: ReactNode;
}) {
  useReportBoundaryError(error);
  return (
    <main
      className="grain brand-glow relative flex min-h-[100dvh] flex-col items-center justify-center px-5 py-10"
      style={brandVars(DEFAULT_BRAND)}
    >
      <div className="relative z-[1] w-full max-w-md">
        <div className="card rounded-[1.75rem] p-8 text-center">
          <div className="text-5xl" aria-hidden="true">
            😵‍💫
          </div>
          {/* Only the message is announced; the controls below are not part of it. */}
          <div role="alert">
            <h1 className="mt-4 text-xl font-extrabold text-ink">{title}</h1>
            <p className="mt-3 text-sm text-muted text-pretty">{body}</p>
          </div>
          <button
            type="button"
            onClick={() => retry?.()}
            className="btn-brand mt-6 inline-flex items-center justify-center rounded-full px-5 py-2.5 text-sm font-semibold"
          >
            Try again
          </button>
          {children}
        </div>
      </div>
    </main>
  );
}
