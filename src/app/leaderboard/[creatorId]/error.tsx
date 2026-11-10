"use client";

// OPS3-06: the database failed (not a missing board): say so, with a retry,
// instead of the 404 an unknown link gets.
import RouteErrorView from "@/components/RouteErrorView";

export default function LeaderboardError({
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
      title="The leaderboard is temporarily unavailable"
      body={<>We couldn&rsquo;t load this board just now. Try again in a moment.</>}
    />
  );
}
