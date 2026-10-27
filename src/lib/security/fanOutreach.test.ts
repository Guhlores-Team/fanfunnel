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

// --- Nothing is ever sent to a fan (D6: option (c), auto-send, is not built) ---
// Win-back fills the creator's message in their browser and copies it when the
// creator taps; the only server call is the outreach log. No win-back module
// may reach the chat/messages API or table, or any other sending surface.
{
  const files = [
    "src/components/dashboard/WinbackQueue.tsx",
    "src/components/dashboard/winbackActions.ts",
    "src/components/dashboard/winbackIntent.ts",
    "src/components/dashboard/CrmPanel.tsx",
    "src/lib/winback/config.ts",
    "src/lib/winback/list.ts",
    "src/lib/winback/template.ts",
    "src/lib/data/outreach.ts",
    "src/app/api/crm/outreach/route.ts",
  ];
  const allowedApi = new Set(["/api/crm", "/api/crm/outreach", "/api/dm-templates", "/api/account"]);
  for (const f of files) {
    const src = readFileSync(join(ROOT, f), "utf8").replace(/\/\/[^\n]*/g, "");
    const apis = [...src.matchAll(/["'`](\/api\/[a-z0-9/_-]*)/gi)].map((m) => m[1]);
    const stray = apis.filter((a) => !allowedApi.has(a));
    check(`${f}: calls no sending API (${stray.join(", ") || "none"})`, stray.length === 0);
    const tables = [...src.matchAll(/\.from\(["'`]([a-z_]+)["'`]\)/g)].map((m) => m[1]);
    check(`${f}: touches no table but fan_outreach (${tables.join(", ") || "none"})`, tables.every((t) => t === "fan_outreach"));
    check(`${f}: no message/chat/push/email send`, !/sendMessage|sendPush|sendEmail|webpush|\.rpc\(/.test(src));
  }
  const cfg = readFileSync(join(ROOT, "src/lib/winback/config.ts"), "utf8");
  check("D6 has no auto-send mode: WinbackMode is copy | queue only", /export type WinbackMode = "copy" \| "queue";/.test(cfg));
  // Copying and logging happen only in the creator's own tap: no effect does
  // either on its own, and a contact is logged only after the copy succeeded.
  const effects = (src: string) => {
    const out: string[] = [];
    for (let i = src.indexOf("useEffect("); i !== -1; i = src.indexOf("useEffect(", i + 1)) {
      let depth = 0;
      let j = i + "useEffect".length;
      do {
        if (src[j] === "(") depth++;
        else if (src[j] === ")") depth--;
        j++;
      } while (depth > 0 && j < src.length);
      out.push(src.slice(i, j));
    }
    return out;
  };
  for (const f of ["src/components/dashboard/WinbackQueue.tsx", "src/components/dashboard/CrmPanel.tsx"]) {
    const src = readFileSync(join(ROOT, f), "utf8");
    const auto = effects(src).filter((e) => /copyToClipboard|postOutreach|winbackMessage/.test(e));
    check(`${f}: no effect copies or logs by itself`, auto.length === 0);
    const contacted = [...src.matchAll(/postOutreach\([^;]*"contacted"/g)];
    check(`${f}: logs a contact somewhere (the guard below is not vacuous)`, contacted.length > 0);
    for (const m of contacted) {
      const before = src.slice(Math.max(0, m.index! - 600), m.index);
      check(`${f}: a contact is logged only after the creator's copy succeeded`, /if \(!\(await copyToClipboard\(/.test(before));
    }
  }
}

console.log(`fanOutreach: ${passed} checks passed`);
