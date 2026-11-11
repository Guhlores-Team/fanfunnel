"use client";

// Route-level error boundary: a page that throws while rendering lands here
// (inside the root layout) and the error is reported to error monitoring.
// Same reassurance as global-error.tsx: server state is authoritative, so the
// fan's spins and balance are safe.
import RouteErrorView from "@/components/RouteErrorView";

export default function RouteError({
  error,
  reset,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  reset?: () => void;
  unstable_retry?: () => void;
}) {
  return (
    <RouteErrorView
      error={error}
      retry={unstable_retry ?? reset}
      body={<>A hiccup on our end interrupted this page. Your spins and balance are safe. Try again &mdash; and if it keeps happening, let your creator know.</>}
    />
  );
}
