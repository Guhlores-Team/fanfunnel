/**
 * AUTH-SENSITIVE (AGENTS.md rules 4/5/6): the win-back outreach log (RM-5,
 * migration 0051).
 *
 * fan_outreach is written by the creator's own session (anon key + RLS). This
 * pins its shape in the migration and both SQL snapshots: RLS on; a SELECT and
 * an INSERT policy only (append-only: no UPDATE / DELETE policy); the insert
 * check gates on can_act_for(…, 'chat') and pins the fan and any template to the
 * same creator; anon has no table privilege; no function is added. It also pins
 * the app side: the data layer uses the session client and takes the creator id
 * from auth.getUser(), and the route never reads a creator id from the body.
 * The runtime half is scripts/db/schema-drift-check.mjs (probeOutreach) and
 * scripts/security/rls-runtime-test.mjs.
 */
import assert from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../../..");
const SUPA = join(ROOT, "supabase");

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const norm = (s: string) =>
  s
    .replace(/--[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const migFile = readdirSync(join(SUPA, "migrations")).find((f) => /^0051_fan_outreach\.sql$/.test(f));
check("migration 0051_fan_outreach.sql exists", !!migFile);
const mig = norm(readFileSync(join(SUPA, "migrations", migFile!), "utf8"));

const policies = (sql: string) =>
  [...sql.matchAll(/create policy (\w+) on public\.fan_outreach for (\w+)/g)].map((m) => `${m[1]}:${m[2]}`);

for (const [name, sql] of [
  ["migration 0051", mig],
  ["schema.sql", norm(readFileSync(join(SUPA, "schema.sql"), "utf8"))],
  ["migrations_combined.sql", norm(readFileSync(join(SUPA, "migrations_combined.sql"), "utf8"))],
] as const) {
  check(`${name}: creates fan_outreach`, sql.includes("create table if not exists public.fan_outreach ("));
  check(`${name}: creator and fan cascade`, /creator_id uuid not null references public\.profiles\(id\) on delete cascade/.test(sql) && /fan_id uuid not null references public\.fans\(id\) on delete cascade/.test(sql));
  check(`${name}: a row records a contact or a snooze`, sql.includes("constraint fan_outreach_has_action check (contacted_at is not null or snoozed_until is not null)"));
  check(`${name}: enables RLS`, sql.includes("alter table public.fan_outreach enable row level security"));
  check(
    `${name}: exactly a SELECT and an INSERT policy (append-only)`,
    JSON.stringify(policies(sql)) === JSON.stringify(["fan_outreach_select:select", "fan_outreach_insert:insert"]),
  );
  check(
    `${name}: SELECT is the creator (or a seat), active, or an admin`,
    sql.includes(
      "create policy fan_outreach_select on public.fan_outreach for select using ((public.can_act_for(creator_id, 'view') and public.current_user_active()) or public.is_admin());",
    ),
  );
  const insert = sql.slice(sql.indexOf("create policy fan_outreach_insert"), sql.indexOf(";", sql.indexOf("create policy fan_outreach_insert")));
  check(`${name}: INSERT needs can_act_for(…, 'chat') or admin`, insert.includes("(public.can_act_for(creator_id, 'chat') or public.is_admin())"));
  check(`${name}: INSERT pins the fan to the row's creator`, insert.includes("where f.id = fan_outreach.fan_id and f.creator_id = fan_outreach.creator_id"));
  check(`${name}: INSERT pins any template to the row's creator`, insert.includes("where t.id = fan_outreach.template_id and t.creator_id = fan_outreach.creator_id"));
  check(`${name}: nothing reads user_metadata / app_metadata`, !/(user|app)_metadata/.test(insert));
  check(`${name}: anon has no table privilege`, sql.includes("revoke all on table public.fan_outreach from anon;"));
}

check("0051 adds no function", !/create (or replace )?function/.test(mig));
check("0051 adds no UPDATE/DELETE/ALL policy", !/for (update|delete|all)/.test(mig));
check("0051 grants nothing", !/\bgrant\b/.test(mig));
check("0051 has no wide-open clause", !/using \(\s*true\s*\)|with check \(\s*true\s*\)/.test(mig));

// --- App side -----------------------------------------------------------------
const dataSrc = readFileSync(join(ROOT, "src/lib/data/outreach.ts"), "utf8");
check("the data layer never imports the service client", !/createServiceClient/.test(dataSrc));
check(
  "the insert runs on the session client, as the signed-in creator",
  /await createClient\(\)[\s\S]*?auth\.getUser\(\)[\s\S]*?if \(!user\) return \{ error: "unauthorized" \}[\s\S]*?\.from\("fan_outreach"\)\.insert\(\{\s*creator_id: user\.id,/.test(dataSrc),
);
check(
  "the read is filtered to the signed-in creator",
  /\.from\("fan_outreach"\)[\s\S]*?\.eq\("creator_id", user\.id\)/.test(dataSrc),
);
const route = readFileSync(join(ROOT, "src/app/api/crm/outreach/route.ts"), "utf8");
check("the route reads no creator/user id from the body", !/creator_?id|user_?id/i.test(route.replace(/\/\/[^\n]*/g, "")));
check("the route never imports the server Supabase module", !/@\/lib\/supabase\/server/.test(route));

console.log(`fanOutreach: ${passed} checks passed`);
