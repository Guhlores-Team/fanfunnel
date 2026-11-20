"use client";

import { useEffect } from "react";
import { markAccountSuspended, SUSPENDED_MESSAGE, SUSPENDED_TITLE } from "@/lib/onboarding/suspended";

/** C11: shown above every dashboard section while the account is suspended. */
export default function SuspendedBanner({ suspended }: { suspended: boolean }) {
  useEffect(() => {
    markAccountSuspended(suspended);
    return () => markAccountSuspended(false);
  }, [suspended]);
  if (!suspended) return null;
  return (
    <div
      role="alert"
      data-testid="suspended-banner"
      className="mb-5 rounded-2xl border border-amber-400/40 bg-amber-400/10 px-4 py-3 text-sm text-amber-100"
    >
      <p className="font-bold text-amber-50">{SUSPENDED_TITLE}</p>
      <p className="mt-1 text-pretty">{SUSPENDED_MESSAGE}</p>
    </div>
  );
}
