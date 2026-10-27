import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RETENTION_CRON_SCHEDULE, RETENTION_DAYS } from "./retention";

// The retention periods are set in ONE file; the public doc and the cron
// schedule must agree with it, and every period must be a sane whole number of
// days (the database also refuses anything under 1 day).

const REPO = join(import.meta.dirname, "../../..");
const doc = readFileSync(join(REPO, "docs/DATA_RETENTION.md"), "utf8");
const vercel = JSON.parse(readFileSync(join(REPO, "vercel.json"), "utf8")) as { crons?: { path: string; schedule: string }[] };

let passed = 0;
const check = (label: string, cond: unknown) => {
  assert.ok(cond, label);
  passed++;
};

const TABLE: Record<keyof typeof RETENTION_DAYS, string> = {
  adminAuditLog: "admin_audit_log",
  creatorNotices: "creator_notices",
  linkTombstones: "link_tombstones",
  resolvedAppErrors: "app_errors",
};

for (const [key, days] of Object.entries(RETENTION_DAYS) as [keyof typeof RETENTION_DAYS, number][]) {
  check(`${key}: whole days, at least 30`, Number.isInteger(days) && days >= 30 && days <= 3650);
  const row = doc.split("\n").find((l) => l.includes(`\`${TABLE[key]}\``) && l.startsWith("|"));
  check(`${key}: DATA_RETENTION.md lists ${days} days for ${TABLE[key]}`, row?.includes(`**${days} days`));
}

const cron = vercel.crons?.find((c) => c.path === "/api/cron/retention");
check("vercel.json schedules the retention route", !!cron);
check("vercel.json schedule matches RETENTION_CRON_SCHEDULE", cron?.schedule === RETENTION_CRON_SCHEDULE);
check("the doc states the schedule", doc.includes("04:17 UTC") && RETENTION_CRON_SCHEDULE === "17 4 * * *");
check("the doc says business records are never deleted by age", /Never deleted by age/.test(doc));

console.log(`retention.test: ${passed} checks passed`);
