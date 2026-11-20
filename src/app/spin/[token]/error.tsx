"use client";

// A41: the fan page's own error state. A read that fails while the page
// renders lands here instead of a blank page. No loading.tsx on purpose:
// next.config.ts keeps metadata blocking (htmlLimitedBots) so the <title>
// never goes missing after a refresh, and a loading boundary would stream it.
// The fan keeps their data controls even while the page can't load.
import RouteErrorView from "@/components/RouteErrorView";
import LinkDataRescue from "@/components/fan/LinkDataRescue";

export default function SpinError({
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
      title="Your spin page didn't load"
      body={<>Something on our side stopped this page loading. Your spins, wins and balance are safe on your account &mdash; nothing was spent. Try again in a moment.</>}
    >
      <LinkDataRescue />
    </RouteErrorView>
  );
}
