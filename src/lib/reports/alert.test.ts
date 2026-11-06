import assert from "node:assert";
import type { AlertConfig, AlertMail } from "@/lib/monitoring/alert";
import { CHILD_SAFETY_REPORT_REASON, ILLEGAL_REPORT_REASON, REPORT_ALERTS_PER_HOUR, REPORT_REASONS } from "./config";
import { PHOTO_REPORT_REASON } from "@/lib/creatorTheme/config";
import { adminReportsUrl, alertUrgentReport, buildReportAlertEmail } from "./alert";

// A1: an urgent safety report (a minor, illegal content, an inappropriate
// photo) e-mails ALERT_EMAIL_TO through the monitoring sender, at most
// REPORT_ALERTS_PER_HOUR per hour, only in alerting environments, and the
// e-mail never carries the fan's identity, link or words.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const cfg: AlertConfig = {
  enabled: true,
  apiKey: "re_test",
  to: ["ops@example.com"],
  from: "FanFunnel Alerts <alerts@example.com>",
  environments: ["development"],
  maxPerHour: 10,
};

async function main() {
  check("the Safety menu offers a child-safety reason", (REPORT_REASONS as readonly string[]).includes(CHILD_SAFETY_REPORT_REASON));
  check("…and the photo reason", (REPORT_REASONS as readonly string[]).includes(PHOTO_REPORT_REASON));

  const sent: AlertMail[] = [];
  const send = async (_c: AlertConfig, mail: AlertMail) => {
    sent.push(mail);
    return true;
  };
  let budget = REPORT_ALERTS_PER_HOUR;
  const keys: string[] = [];
  const limit = async (key: string, max: number) => {
    keys.push(key);
    check("the hourly budget is the configured one", max === REPORT_ALERTS_PER_HOUR);
    return { ok: budget-- > 0 };
  };
  const at = "2026-10-29T12:34:56.000Z";

  for (const reason of [CHILD_SAFETY_REPORT_REASON, ILLEGAL_REPORT_REASON, PHOTO_REPORT_REASON]) {
    check(`${reason}: alerts`, await alertUrgentReport({ reason, at }, { cfg, send, limit }));
  }
  check("three urgent reports → three e-mails", sent.length === 3);
  check("an everyday reason does not alert", !(await alertUrgentReport({ reason: "Not delivering won prizes", at }, { cfg, send, limit })) && sent.length === 3);
  check("a free-text reason does not alert", !(await alertUrgentReport({ reason: "Other", at }, { cfg, send, limit })));
  check("one shared throttle key", keys.every((k) => k === "alerts:urgent-report"));

  const mail = sent[0];
  check("subject names the reason", mail.subject.includes(CHILD_SAFETY_REPORT_REASON) && mail.subject.startsWith("[FanFunnel development]"));
  check("text says when", mail.text.includes("2026-10-29 12:34:56 UTC"));
  check("the e-mail promises no fan data", mail.text.includes("never includes who sent the report"));

  // Fan data can't reach the e-mail: the builder only takes reason + time.
  const built = buildReportAlertEmail({ reason: "Inappropriate photo\r\nBcc: x@evil.test", at }, "production", null);
  check("header injection is flattened", !/[\r\n]/.test(built.subject));
  check("HTML is escaped", !buildReportAlertEmail({ reason: "<script>x</script>", at }, "production", null).html.includes("<script>x"));

  // Throttle: once the hour's budget is spent, nothing more is sent.
  budget = 0;
  check("over the hourly budget: no e-mail", !(await alertUrgentReport({ reason: PHOTO_REPORT_REASON, at }, { cfg, send, limit })) && sent.length === 3);
  budget = 5;

  // Environments and configuration gate it like error alerts.
  check("a non-alerting environment does not e-mail", !(await alertUrgentReport({ reason: PHOTO_REPORT_REASON, at }, { cfg: { ...cfg, environments: ["production"] }, send, limit })));
  check("alerts off (no Resend key / recipient) does not e-mail", !(await alertUrgentReport({ reason: PHOTO_REPORT_REASON, at }, { cfg: { ...cfg, enabled: false }, send, limit })));
  check("a failing sender never throws", (await alertUrgentReport({ reason: PHOTO_REPORT_REASON, at }, { cfg, limit, send: async () => { throw new Error("boom"); } })) === false);

  check("the link opens Admin › Reports", adminReportsUrl({ NEXT_PUBLIC_SITE_URL: "https://fanfunnel.example" } as unknown as NodeJS.ProcessEnv) === "https://fanfunnel.example/dashboard?section=admin#reports");
  check("no origin, no link", adminReportsUrl({} as unknown as NodeJS.ProcessEnv) === null);

  console.log(`reports/alert.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
