import assert from "node:assert";
import type { AlertConfig, AlertMail } from "@/lib/monitoring/alert";
import { CHILD_SAFETY_ALERTS_PER_HOUR, CHILD_SAFETY_REPORT_REASON, ILLEGAL_REPORT_REASON, REPORT_ALERTS_PER_HOUR, REPORT_REASONS, isChildSafetyReportReason } from "./config";
import { PHOTO_REPORT_REASON } from "@/lib/creatorTheme/config";
import { CHILD_SAFETY_ALERT_KEY, SUPPRESSED_SUMMARY_KEY, URGENT_ALERT_KEY, adminReportsUrl, alertUrgentReport, buildReportAlertEmail, buildSuppressedSummaryEmail } from "./alert";

// A1: an urgent safety report (a minor, illegal content, an inappropriate
// photo) e-mails ALERT_EMAIL_TO through the monitoring sender, at most
// REPORT_ALERTS_PER_HOUR per hour, only in alerting environments, and the
// e-mail never carries the fan's identity, link or words. T6: child-safety
// reasons draw on their own budget, and a spent budget sends one "N alerts
// suppressed this hour" summary instead of going silent.

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
  // Separate budgets per key, like the shared limiter.
  const budgets = new Map<string, number>([[URGENT_ALERT_KEY, REPORT_ALERTS_PER_HOUR], [CHILD_SAFETY_ALERT_KEY, CHILD_SAFETY_ALERTS_PER_HOUR], [SUPPRESSED_SUMMARY_KEY, 1]]);
  let budget = REPORT_ALERTS_PER_HOUR;
  const keys: string[] = [];
  const limit = async (key: string, max: number) => {
    keys.push(key);
    if (key === URGENT_ALERT_KEY) {
      check("the shared hourly budget is the configured one", max === REPORT_ALERTS_PER_HOUR);
      return { ok: budget-- > 0 };
    }
    if (key === CHILD_SAFETY_ALERT_KEY) check("child safety has its own configured budget", max === CHILD_SAFETY_ALERTS_PER_HOUR);
    if (key === SUPPRESSED_SUMMARY_KEY) check("one summary an hour", max === 1);
    const left = budgets.get(key) ?? 0;
    budgets.set(key, left - 1);
    return { ok: left > 0 };
  };
  const at = "2026-10-29T12:34:56.000Z";

  for (const reason of [CHILD_SAFETY_REPORT_REASON, ILLEGAL_REPORT_REASON, PHOTO_REPORT_REASON]) {
    check(`${reason}: alerts`, await alertUrgentReport({ reason, at }, { cfg, send, limit }));
  }
  check("three urgent reports → three e-mails", sent.length === 3);
  check("an everyday reason does not alert", !(await alertUrgentReport({ reason: "Not delivering won prizes", at }, { cfg, send, limit })) && sent.length === 3);
  check("a free-text reason does not alert", !(await alertUrgentReport({ reason: "Other", at }, { cfg, send, limit })));
  check("photo and illegal reports share one throttle key", keys.filter((k) => k !== CHILD_SAFETY_ALERT_KEY).every((k) => k === URGENT_ALERT_KEY));
  check("the child-safety report used its own key", keys[0] === CHILD_SAFETY_ALERT_KEY && isChildSafetyReportReason(CHILD_SAFETY_REPORT_REASON));

  const mail = sent[0];
  check("subject names the reason", mail.subject.includes(CHILD_SAFETY_REPORT_REASON) && mail.subject.startsWith("[FanFunnel development]"));
  check("text says when", mail.text.includes("2026-10-29 12:34:56 UTC"));
  check("the e-mail promises no fan data", mail.text.includes("never includes who sent the report"));

  // Fan data can't reach the e-mail: the builder only takes reason + time.
  const built = buildReportAlertEmail({ reason: "Inappropriate photo\r\nBcc: x@evil.test", at }, "production", null);
  check("header injection is flattened", !/[\r\n]/.test(built.subject));
  check("HTML is escaped", !buildReportAlertEmail({ reason: "<script>x</script>", at }, "production", null).html.includes("<script>x"));

  // Throttle: once the hour's budget is spent, the report's own e-mail is held
  // back, and ONE summary e-mail says alerts are being suppressed.
  budget = 0;
  const now = () => Date.parse("2026-10-29T12:40:00Z");
  check("over the hourly budget: no report e-mail", !(await alertUrgentReport({ reason: PHOTO_REPORT_REASON, at }, { cfg, send, limit, now })));
  check("…but one summary e-mail goes out", sent.length === 4 && /1 alert suppressed this hour/.test(sent[3].subject));
  check("…naming the limit, with no fan data", sent[3].text.includes(`limit of ${REPORT_ALERTS_PER_HOUR} urgent report alerts`) && !/[A-Za-z0-9._%+-]+@/.test(sent[3].text));
  check("a second suppressed alert sends no second summary", !(await alertUrgentReport({ reason: ILLEGAL_REPORT_REASON, at }, { cfg, send, limit, now })) && sent.length === 4);

  // T6: a flood that spends the shared budget never touches child safety's.
  check("with the shared budget spent, an under-18 report still alerts", await alertUrgentReport({ reason: CHILD_SAFETY_REPORT_REASON, at }, { cfg, send, limit, now }));
  check("…as a real report e-mail", sent.length === 5 && sent[4].subject.includes(CHILD_SAFETY_REPORT_REASON));
  budget = 5;

  const summary = buildSuppressedSummaryEmail({ suppressed: 7, perHour: 30, childSafety: true }, "production", null);
  check("summary: subject counts the suppressed alerts", summary.subject === "[FanFunnel production] 7 alerts suppressed this hour");
  check("summary: names the child-safety budget when that one is spent", summary.text.includes("30 child-safety report alerts"));

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
