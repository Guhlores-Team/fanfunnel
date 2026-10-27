"use client";

import { useEffect } from "react";
import { SERVICE_WORKER_SCOPE, SERVICE_WORKER_URL } from "@/lib/pwa/config";

/**
 * Registers the app service worker for the creator dashboard only (scope
 * /dashboard). It has no fetch handler, so it caches nothing; it exists so the
 * installed dashboard app has a worker for web push to extend. Renders nothing.
 */
export default function AppServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .register(SERVICE_WORKER_URL, { scope: SERVICE_WORKER_SCOPE, updateViaCache: "none" })
      .catch(() => {
        /* unsupported or blocked (e.g. private mode): the dashboard works without it */
      });
  }, []);
  return null;
}
