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
  pushLog: "push_log",
  creatorNotices: "creator_notices",
  linkTombstones: "link_tombstones",
  resolvedAppErrors: "app_errors",
  closedAgencyInvites: "org_invites",
};

for (const [key, days] of Object.entries(RETENTION_DAYS) as [keyof typeof RETENTION_DAYS, number][]) {
  check(`${key}: whole days, at least 30`, Number.isInteger(days) && days >= 30 && days <= 3650);
  const row = doc.split("\n").find((l) => l.includes(`\`${TABLE[key]}\``) && l.startsWith("|"));
  check(`${key}: DATA_RETENTION.md lists ${days} days for ${TABLE[key]}`, row?.includes(`**${days} days`));
}

// Keep the same five-argument RPC contract while pinning its named SQL
// push-log constant to the shared application period in every SQL build path.
for (const file of ["supabase/migrations/0056_push_subscriptions.sql", "supabase/schema.sql", "supabase/migrations_combined.sql"]) {
  const sql = readFileSync(join(REPO, file), "utf8").replace(/--[^\n]*/g, " ");
  const definitions = [...sql.matchAll(/create or replace function public\.run_retention_cleanup\([\s\S]*?\$\$;/g)];
  const fn = definitions.at(-1)?.[0] ?? "";
  const days = Number(fn.match(/v_push_log_days constant integer := (\d+);/)?.[1]);
  check(`${file}: deterministic push-log period matches the shared config`, days === RETENTION_DAYS.pushLog);
  check(`${file}: push-log cleanup is unconditional in the daily RPC`, /delete from public\.push_log\s+where sent_at < now\(\) - make_interval\(days => v_push_log_days\)/.test(fn));
  check(`${file}: cleanup counts deleted push logs`, /'push_log', v_push_log/.test(fn));
  check(`${file}: cleanup remains a server-only five-argument RPC`, /revoke execute on function public\.run_retention_cleanup\(integer, integer, integer, integer, integer\) from public, anon, authenticated/.test(sql));
}

const cron = vercel.crons?.find((c) => c.path === "/api/cron/retention");
check("vercel.json schedules the retention route", !!cron);
check("vercel.json schedule matches RETENTION_CRON_SCHEDULE", cron?.schedule === RETENTION_CRON_SCHEDULE);
check("the doc states the schedule", doc.includes("04:17 UTC") && RETENTION_CRON_SCHEDULE === "17 4 * * *");
check("the doc says business records are never deleted by age", /Never deleted by age/.test(doc));

console.log(`retention.test: ${passed} checks passed`);
