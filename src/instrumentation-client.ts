// Runs before hydration on every page, in every environment: start reporting
// uncaught browser errors and unhandled rejections to /api/errors.
import { installErrorMonitor } from "@/lib/monitoring/client";

try {
  installErrorMonitor();
} catch {
  /* monitoring must never block the app */
}
