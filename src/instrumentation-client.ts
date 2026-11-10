// Runs before hydration on every page, in every environment: start reporting
// uncaught browser errors and unhandled rejections to /api/errors.
import { installErrorMonitor } from "@/lib/monitoring/client";
import { installApiResponseDrain } from "@/lib/api/drainResponses";

try {
  installErrorMonitor();
} catch {
  /* monitoring must never block the app */
}

// RS-04: read every no-store /api answer to the end, so a call site that only
// checks `res.ok` cannot leave its request pending (src/lib/api/drainResponses.ts).
try {
  installApiResponseDrain();
} catch {
  /* never block the app */
}
