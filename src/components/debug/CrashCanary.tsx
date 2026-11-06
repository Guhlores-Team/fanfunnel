"use client";

import { useEffect, useState } from "react";
import { isDebugActive } from "./debug";

/**
 * A debug-only "crash test" hook (mounted only in NEXT_PUBLIC_ENABLE_DEBUG=1
 * builds). Renders nothing and ignores the event unless debug mode is active
 * (admin-confirmed + ?debug=1). When the DebugConsole dispatches the
 * `ff:debug:crash` event, this throws during render so the surrounding
 * DebugErrorBoundary catches it — letting you exercise the render-error path
 * (boundary fallback + console capture) on demand. Mounted INSIDE the boundary.
 */
export default function CrashCanary() {
  const [crash, setCrash] = useState(false);

  useEffect(() => {
    // The gate is checked when the event fires, not at mount: the console only
    // confirms the admin (setDebugAdmin) after this effect has run, so a
    // mount-time check left the crash-test button permanently inert.
    const onCrash = () => {
      if (isDebugActive()) setCrash(true);
    };
    window.addEventListener("ff:debug:crash", onCrash);
    return () => window.removeEventListener("ff:debug:crash", onCrash);
  }, []);

  if (crash) {
    throw new Error("Forced render crash (debug crash-test button)");
  }
  return null;
}
