"use client";

import { useEffect, useState } from "react";
import { isDebugActive } from "./debug";

/**
 * A debug-only "crash test" hook. Renders nothing and registers no listener
 * unless debug mode is active. When the DebugConsole dispatches the
 * `ff:debug:crash` event, this throws during render so the surrounding
 * DebugErrorBoundary catches it — letting you exercise the render-error path
 * (boundary fallback + console capture) on demand. Mounted INSIDE the boundary.
 */
export default function CrashCanary() {
  const [crash, setCrash] = useState(false);

  useEffect(() => {
    if (!isDebugActive()) return;
    const onCrash = () => setCrash(true);
    window.addEventListener("ff:debug:crash", onCrash);
    return () => window.removeEventListener("ff:debug:crash", onCrash);
  }, []);

  if (crash) {
    throw new Error("Forced render crash (debug crash-test button)");
  }
  return null;
}
