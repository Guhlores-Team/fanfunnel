"use client";

import RouteErrorView from "@/components/RouteErrorView";

/**
 * The error state for creator-side pages (dashboard, agency, admin and the
 * account pages). The root error.tsx speaks to fans ("your spins and balance
 * are safe"), which reads wrong to a creator (QA b5 m10).
 */
export default function CreatorRouteError({
  error,
  retry,
  home = true,
}: {
  error: Error & { digest?: string };
  retry?: () => void;
  /** Offer a link back to the dashboard (not on the dashboard itself). */
  home?: boolean;
}) {
  return (
    <RouteErrorView
      error={error}
      retry={retry}
      title="This page didn't load"
      body={<>Something on our side stopped this page loading. Everything you already saved (games, fans, campaigns and settings) is safe. Try again in a moment.</>}
    >
      {home && (
        <p className="mt-4 text-sm">
          <a href="/dashboard" className="font-semibold text-ink underline underline-offset-2">
            Back to the dashboard
          </a>
        </p>
      )}
    </RouteErrorView>
  );
}
