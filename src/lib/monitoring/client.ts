// Browser side of error monitoring: window errors, unhandled rejections and
// React error boundaries are redacted HERE first, then POSTed to /api/errors
// (which redacts again before storing). Runs in every environment; the debug
// console UI stays Preview-only. Reporting is best-effort and never throws.
import { scrub, scrubRoute, truncate } from "./scrub";
import { isNoise, type ReportKind } from "./report";

/** Reports per page load, so a render loop cannot flood the endpoint. */
const MAX_REPORTS_PER_PAGE = 10;
const sent = new Set<string>();

/** A readable message for whatever was thrown or rejected. */
export function describeThrown(reason: unknown): { message: string; stack?: string } {
  if (reason instanceof Error) return { message: reason.message || reason.name || "Error", stack: reason.stack };
  if (typeof reason === "string") return { message: reason };
  try {
    return { message: JSON.stringify(reason) ?? String(reason) };
  } catch {
    return { message: String(reason) };
  }
}

/** Build the redacted request body, or null when there is nothing to send. */
export function buildReport(
  e: { message: string; stack?: string; kind: ReportKind },
  pathname: string,
): { message: string; kind: ReportKind; stack?: string; route?: string } | null {
  const message = truncate(scrub(e.message)?.trim(), 2000);
  if (!message) return null;
  const stack = truncate(scrub(e.stack), 8000);
  if (isNoise(message, stack)) return null;
  const route = scrubRoute(pathname);
  return { message, kind: e.kind, ...(stack ? { stack } : {}), ...(route ? { route } : {}) };
}

/** Send one error report. Deduplicated per page load and capped. */
export function reportClientError(e: { message: string; stack?: string; kind: ReportKind }): void {
  try {
    if (typeof window === "undefined" || typeof fetch !== "function") return;
    const body = buildReport(e, window.location.pathname);
    if (!body) return;
    const key = `${body.message}\n${body.stack?.split("\n", 3).join("\n") ?? ""}`;
    if (sent.has(key) || sent.size >= MAX_REPORTS_PER_PAGE) return;
    sent.add(key);
    void fetch("/api/errors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
      credentials: "omit",
    }).catch(() => {});
  } catch {
    /* monitoring must never throw */
  }
}

/** Register the window listeners once (instrumentation-client.ts calls this). */
export function installErrorMonitor(): void {
  if (typeof window === "undefined") return;
  const w = window as unknown as { __ffErrorMonitor?: boolean };
  if (w.__ffErrorMonitor) return;
  w.__ffErrorMonitor = true;
  window.addEventListener("error", (ev) => {
    // Resource load failures (img/script 404) are not ErrorEvents.
    if (!(ev instanceof ErrorEvent)) return;
    const thrown = ev.error ? describeThrown(ev.error) : { message: ev.message || "Unknown error" };
    reportClientError({ ...thrown, kind: "error" });
  });
  window.addEventListener("unhandledrejection", (ev) => {
    const thrown = describeThrown(ev.reason);
    reportClientError({ message: thrown.message || "Unhandled promise rejection", stack: thrown.stack, kind: "unhandledrejection" });
  });
}
