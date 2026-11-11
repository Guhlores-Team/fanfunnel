// OPS-02/OPS-08: an external "dead man's switch". After each successful
// maintenance run the cron GETs HEARTBEAT_URL (e.g. a Healthchecks.io or
// UptimeRobot heartbeat). If the cron stops, or the database is down so the run
// fails, the monitor stops hearing from us and e-mails the owner — the one
// alert that does not depend on our own database or e-mail.
export const HEARTBEAT_TIMEOUT_MS = 3_000;

/** Never throws. The URL is a capability: it is never logged or returned. */
export async function pingHeartbeat(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<"sent" | "off" | "failed"> {
  const raw = (env.HEARTBEAT_URL ?? "").trim();
  if (!raw) return "off";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    console.warn("[heartbeat] HEARTBEAT_URL is not a valid URL; not pinged.");
    return "failed";
  }
  if (url.protocol !== "https:") {
    console.warn("[heartbeat] HEARTBEAT_URL must use https; not pinged.");
    return "failed";
  }
  try {
    const res = await fetchImpl(url, { method: "GET", cache: "no-store", redirect: "follow", signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS) });
    if (!res.ok) console.warn(`[heartbeat] ping was not accepted (HTTP ${res.status}).`);
    return res.ok ? "sent" : "failed";
  } catch {
    console.warn("[heartbeat] ping could not be sent.");
    return "failed";
  }
}
