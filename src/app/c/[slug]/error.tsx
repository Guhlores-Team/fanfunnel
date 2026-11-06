"use client";

// A41: the public link-in-bio page's error state (an unknown page is the
// branded 404 instead). No loading.tsx: metadata stays blocking, see
// next.config.ts.
import RouteErrorView from "@/components/RouteErrorView";

export default function PublicPageError({
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
      title="This page didn't load"
      body={<>Something on our side stopped this creator&rsquo;s page loading. Try again in a moment.</>}
    />
  );
}
