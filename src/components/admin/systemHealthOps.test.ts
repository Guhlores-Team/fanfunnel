import assert from "node:assert/strict";
import { alertMailLine, heartbeatLine, maintenanceLine, opsFlagLines, parseSystemHealthStatus, rateLimitFallbackLine } from "./systemHealthCopy";

let passed = 0;
const check = (label: string, ok: unknown) => { assert.ok(ok, label); passed++; };
const flags = { alertEmail: false, accountMail: true, push: false, sharedRateLimit: true, cronSecret: true, heartbeat: false };

const base = { demo: true, canary: { status: "demo" }, summary: null };
const parsed = parseSystemHealthStatus({ ...base, environment: "production", config: flags, maintenance: { lastRanAt: null, stale: true }, rateLimitLastFallbackAt: null });
check("ops fields parse", parsed?.environment === "production" && parsed.config?.push === false && parsed.maintenance?.stale === true && parsed.rateLimitLastFallbackAt === null);
check("a config with a non-boolean is dropped, not shown", parseSystemHealthStatus({ ...base, config: { ...flags, alertEmail: "re_123" } })?.config === undefined);
check("an unknown environment is dropped", parseSystemHealthStatus({ ...base, environment: "staging" })?.environment === undefined);
check("an old response without ops fields still parses", parseSystemHealthStatus(base)?.config === undefined);

const prod = opsFlagLines(flags, "production");
check("alert e-mails OFF is red on Production", prod[0].text === "Alert e-mails: OFF" && prod[0].alarm === true);
check("…but not on a Preview", opsFlagLines(flags, "preview")[0].alarm === false);
check("ON is never red", opsFlagLines({ ...flags, alertEmail: true }, "production")[0].text === "Alert e-mails: ON" && !opsFlagLines({ ...flags, alertEmail: true }, "production")[0].alarm);
check("every service is named", prod.length === 6 && prod.some((l) => l.text === "Push notifications (VAPID key pair): not set") && prod.some((l) => l.text === "Maintenance job secret (CRON_SECRET): configured") && prod.some((l) => l.text === "Uptime heartbeat (HEARTBEAT_URL): not set"));

check("maintenance never ran", maintenanceLine({ lastRanAt: null, stale: false }) === "Maintenance job: no run recorded.");
check("stale says what to check", /^Maintenance job: last ran .+\. Overdue: it should run daily\. Check the Vercel cron and CRON_SECRET\.$/.test(maintenanceLine({ lastRanAt: "2026-11-01T00:00:00Z", stale: true })));
check("fresh run", /^Maintenance job: last ran .+\.$/.test(maintenanceLine({ lastRanAt: "2026-11-01T00:00:00Z", stale: false })));
check("fallback lines", rateLimitFallbackLine(null) === "Rate-limit store: no fallback recorded." && /^Rate-limit store: last fallback to per-instance limits .+\.$/.test(rateLimitFallbackLine("2026-11-01T00:00:00Z")));
  // OPS3-08: the heartbeat's last outcome and the alert mail's last acceptance are facts, not "configured".
  const parseFull = parseSystemHealthStatus;
  check("heartbeat off", heartbeatLine({ configured: false, lastResult: "off", at: null }).text === "Heartbeat: not set.");
  check("heartbeat never pinged", /no ping sent yet/.test(heartbeatLine({ configured: true, lastResult: "never", at: null }).text));
  check("heartbeat accepted names the time", /last ping accepted at/.test(heartbeatLine({ configured: true, lastResult: "sent", at: "2026-11-02T04:17:00.000Z" }).text) && !heartbeatLine({ configured: true, lastResult: "sent", at: "2026-11-02T04:17:00.000Z" }).alarm);
  check("heartbeat refused is red and says what to check", heartbeatLine({ configured: true, lastResult: "failed", at: "2026-11-02T04:17:03.000Z" }).alarm && /refused/.test(heartbeatLine({ configured: true, lastResult: "failed", at: "2026-11-02T04:17:03.000Z" }).text) && /HEARTBEAT_URL/.test(heartbeatLine({ configured: true, lastResult: "failed", at: null }).text));
  check("alert mail: accepted at / configured but never / off", /last accepted at/.test(alertMailLine("2026-11-01T10:00:00.000Z", true)) && alertMailLine(null, true) === "Alert e-mail: configured, none accepted yet." && alertMailLine(null, false) === "Alert e-mail: none accepted yet.");
  const parsedOps = parseFull({ demo: false, canary: { status: "healthy" }, summary: null, heartbeat: { configured: true, lastResult: "sent", at: "2026-11-02T04:17:00.000Z" }, alertMail: { lastAcceptedAt: null } });
  check("the parser keeps well-formed heartbeat and alertMail facts", parsedOps?.heartbeat?.lastResult === "sent" && parsedOps?.alertMail?.lastAcceptedAt === null);
  const junk = parseFull({ demo: false, canary: { status: "healthy" }, summary: null, heartbeat: { configured: "yes", lastResult: "sent", at: "soon" }, alertMail: { lastAcceptedAt: 5 } });
  check("…and drops malformed ones", junk !== null && !("heartbeat" in junk) && !("alertMail" in junk));
console.log(`system health ops copy: ${passed} checks passed`);
