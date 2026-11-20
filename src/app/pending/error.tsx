"use client";

// Creator-side error state (the root error.tsx is written for fans).
import CreatorRouteError from "@/components/CreatorRouteError";

export default function RouteError({
  error,
  reset,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  reset?: () => void;
  unstable_retry?: () => void;
}) {
  return <CreatorRouteError error={error} retry={unstable_retry ?? reset} />;
}
