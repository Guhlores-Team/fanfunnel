import assert from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// RM-3 (migration 0050): static guards for the visit glow.
//  1. fan_checkins is select-only for authenticated users: RLS on, a single
//     SELECT policy, no INSERT/UPDATE/DELETE/ALL policy anywhere, and the write
//     privileges revoked from anon and authenticated — in the migration AND in
//     both hand-kept snapshots.
//  2. "A streak never grants spins or changes odds": no SQL function (so not
//     claim_spin) reads fan_checkins, and nothing in the spin engine, the
//     fairness code or the spin path imports the glow.
//  3. Only the server data layer writes fan_checkins, and no client module can
//     reach it (or the service key) through an import.
// The runtime half is in scripts/db/schema-drift-check.mjs (RLS probe) and
// scripts/security/rls-runtime-test.mjs (against the TEST project).

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const ROOT = join(import.meta.dirname, "../../..");
const SUPA = join(ROOT, "supabase");
const read = (p: string) => readFileSync(p, "utf8");
const migration = read(join(SUPA, "migrations/0050_fan_checkins.sql"));
const files: Record<string, string> = {
  "0050": migration,
  "schema.sql": read(join(SUPA, "schema.sql")),
  "migrations_combined.sql": read(join(SUPA, "migrations_combined.sql")),
};
const allMigrations = readdirSync(join(SUPA, "migrations"))
  .filter((f) => f.endsWith(".sql"))
  .map((f) => read(join(SUPA, "migrations", f)))
  .join("\n");
const stripComments = (s: string) => s.replace(/--[^\n]*/g, " ");

// --- 1. select-only ------------------------------------------------------------
for (const [name, sql] of Object.entries(files)) {
  const s = stripComments(sql).toLowerCase();
  check(`${name}: creates fan_checkins with (fan_id, day) as the primary key`, /create table if not exists public\.fan_checkins[\s\S]*?primary key \(fan_id, day\)/.test(s));
  check(`${name}: fan_id cascades with the fan`, /fan_id\s+uuid not null references public\.fans\(id\) on delete cascade/.test(s));
  check(`${name}: enables RLS on fan_checkins`, /alter table public\.fan_checkins\s+enable row level security/.test(s));
  const policies = [...s.matchAll(/create policy (\w+) on public\.fan_checkins\s+for (\w+)/g)];
  check(`${name}: exactly one policy, and it is FOR SELECT`, policies.length === 1 && policies[0][2] === "select");
  check(`${name}: the policy is the owner/view/admin rule`, /fan_checkins_select[\s\S]*?creator_id = auth\.uid\(\) and public\.current_user_active\(\)[\s\S]*?public\.can_act_for\(creator_id, 'view'\)[\s\S]*?public\.is_admin\(\)/.test(s));
  check(`${name}: anon loses every privilege`, /revoke all on table public\.fan_checkins from anon;/.test(s));
  check(`${name}: authenticated can't write`, /revoke insert, update, delete, truncate on table public\.fan_checkins from authenticated;/.test(s));
}
const everywhere = stripComments(Object.values(files).join("\n") + allMigrations).toLowerCase();
check("no write policy on fan_checkins anywhere", !/create policy \w+ on public\.fan_checkins\s+for (insert|update|delete|all)\b/.test(everywhere));
check("no policy on fan_checkins without a FOR clause (= ALL)", !/create policy \w+ on public\.fan_checkins\s+(using|with check)/.test(everywhere));
check("nothing grants a write on fan_checkins back", !/grant [^;]*(insert|update|delete|all)[^;]* on (table )?public\.fan_checkins/.test(everywhere));

// --- 2. no path from a visit to spins or odds ------------------------------------
const fnBodies = [...everywhere.matchAll(/create or replace function public\.(\w+)[\s\S]*?\$\$([\s\S]*?)\$\$/g)];
check("SQL functions were found to scan", fnBodies.length > 20);
check("no SQL function reads fan_checkins (claim_spin can't see visits)", fnBodies.every((m) => !m[2].includes("fan_checkins")));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(e)) out.push(p);
  }
  return out;
}
const SRC = join(ROOT, "src");
const sources = walk(SRC).filter((p) => !p.endsWith(".test.ts"));
const rel = (p: string) => relative(ROOT, p);
const GLOW_IMPORT = /from\s+["'](@\/lib\/glow\/[^"']+|\.\/checkins|@\/lib\/data\/checkins)["']/;

const spinEngine = sources.filter((p) => rel(p).startsWith("src/lib/games/"));
check("the spin engine has files to scan", spinEngine.length > 5);
for (const p of spinEngine) {
  const s = read(p);
  check(`${rel(p)} doesn't import the glow`, !GLOW_IMPORT.test(s) && !s.includes("fan_checkins"));
}
for (const p of ["src/app/api/spin/route.ts", "src/lib/data/spinSeed.ts", "src/lib/data/liveStock.ts", "src/lib/data/boosts.ts"]) {
  const s = read(join(ROOT, p));
  check(`${p} doesn't touch the glow`, !GLOW_IMPORT.test(s) && !s.includes("fan_checkins"));
}
// spins.ts may only READ the glow for the page (getFanPass); the spin function must not.
{
  const s = read(join(ROOT, "src/lib/data/spins.ts"));
  const spinFn = s.slice(s.indexOf("export async function spin("), s.indexOf("export async function createPass("));
  check("spins.ts: spin()/claim path never mentions the glow", spinFn.length > 1000 && !/glow|checkin/i.test(spinFn));
  check("spins.ts imports only the read, readFanGlow", /import \{ readFanGlow \} from "\.\/checkins";/.test(s) && !s.includes("recordCheckin"));
}

// --- 3. writes are server-only ----------------------------------------------------
const writers = sources.filter((p) => /from\(["']fan_checkins["']\)\s*\.\s*(upsert|insert|update|delete)/.test(read(p).replace(/\s+/g, " ")));
check("only src/lib/data/checkins.ts writes fan_checkins", writers.length === 1 && rel(writers[0]) === "src/lib/data/checkins.ts");
{
  const s = read(join(ROOT, "src/lib/data/checkins.ts"));
  check("checkins.ts writes with the service client", s.includes("createServiceClient()") && !s.includes('"use client"'));
  check("checkins.ts takes fan/creator from the pass row", /fan_id: pass\.fan_id, creator_id: pass\.creator_id, day/.test(s));
  check("checkins.ts only resolves ACTIVE, unpaused links", /\.eq\("is_active", true\)\s*\.is\("self_excluded_at", null\)/.test(s));
}
const clientFiles = sources.filter((p) => /^\s*["']use client["'];?/.test(read(p)));
check("there are client modules to scan", clientFiles.length > 10);
const SERVER_IMPORT = /^import (?!type\b)[^;]*from ["'](@\/lib\/data\/checkins|@\/lib\/supabase\/server|@\/lib\/data)["']/m;
const leaking = clientFiles.filter((p) => SERVER_IMPORT.test(read(p))).map(rel);
check(`no client module imports checkins, the data barrel or supabase/server (${leaking.join(", ") || "none"})`, leaking.length === 0);
const route = read(join(ROOT, "src/app/api/fan/checkin/route.ts"));
check("the route is rate-limited", /rateLimitOr429\(/.test(route));
check("the route never reads ids from the body", !/body\.(fanId|fan_id|creatorId|creator_id)/.test(route));

console.log(`fan_checkins guards: ${passed} checks passed`);
