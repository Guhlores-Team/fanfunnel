"use client";

// Route-level error boundary: a page that throws while rendering lands here
// (inside the root layout) and the error is reported to error monitoring.
// Same reassurance as global-error.tsx: server state is authoritative, so the
// fan's spins and balance are safe.
import { brandVars, DEFAULT_BRAND } from "@/lib/theme";
import { useReportBoundaryError } from "@/components/monitoring/useReportBoundaryError";

export default function RouteError({
  error,
  reset,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  reset?: () => void;
  unstable_retry?: () => void;
}) {
  useReportBoundaryError(error);
  return (
    <main
      className="grain brand-glow relative flex min-h-[100dvh] flex-col items-center justify-center px-5 py-10"
      style={brandVars(DEFAULT_BRAND)}
    >
      <div className="relative z-[1] w-full max-w-md">
        <div className="card rounded-[1.75rem] p-8 text-center" role="alert">
          <div className="text-5xl" aria-hidden="true">
            😵‍💫
          </div>
          <h1 className="mt-4 text-xl font-extrabold text-ink">Something went sideways</h1>
          <p className="mt-3 text-sm text-muted text-pretty">
            A hiccup on our end interrupted this page. Your spins and balance are safe. Try again &mdash; and if it
            keeps happening, let your creator know.
          </p>
          <button
            type="button"
            onClick={() => (unstable_retry ?? reset)?.()}
            className="btn-brand mt-6 inline-flex items-center justify-center rounded-full px-5 py-2.5 text-sm font-semibold"
          >
            Try again
          </button>
        </div>
      </div>
    </main>
  );
}
