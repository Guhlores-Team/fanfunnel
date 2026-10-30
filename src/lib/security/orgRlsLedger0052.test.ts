/**
 * AUTH-SENSITIVE (AGENTS.md rules 2/5/6/7): migration 0052.
 *
 * Agency/org RLS: the 0014 policies on orgs, org_members and
 * org_member_creators queried each other's tables, so Postgres refused every
 * non-admin access with "infinite recursion detected in policy"; orgs_read
 * also bound `id` to org_members.id; and org_account_stats showed a scoped
 * seat every creator in the org. This pins the fixed shape in the migration
 * and both SQL snapshots, and that the runtime org isolation probe stays wired
 * into the schema-drift check (which runs it on every build path).
 *
 * Suspended accounts: every org helper, the orgs/org_members policies and the
 * org RPCs require an active caller; can_act_for keeps the suspended 'view'
 * only for the caller's own account.
 *
 * Ledger: the non-negative CHECKs are added NOT VALID, then validated only
 * when no row violates them, else dropped again (never left NOT VALID over a
 * bad row, which would make every update of that row fail).
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
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

const sources = [
  ["migration 0052", norm(readFileSync(join(SUPA, "migrations", "0052_org_rls_and_ledger_checks.sql"), "utf8"))],
  ["schema.sql", norm(readFileSync(join(SUPA, "schema.sql"), "utf8"))],
  ["migrations_combined.sql", norm(readFileSync(join(SUPA, "migrations_combined.sql"), "utf8"))],
] as const;

/** The LAST `create policy NAME on public.TABLE ...;` in the file (the effective one). */
function lastPolicy(sql: string, name: string, table: string): string | null {
  const re = new RegExp(`create policy ${name} on public\\.${table}\\b[^;]*;`, "g");
  const all = sql.match(re);
  return all ? all[all.length - 1] : null;
}
function lastFn(sql: string, name: string): string | null {
  const re = new RegExp(`create or replace function public\\.${name}\\s*\\([\\s\\S]*?as \\$\\$[\\s\\S]*?\\$\\$\\s*;`, "g");
  const all = sql.match(re);
  return all ? all[all.length - 1] : null;
}

const ORG_POLICIES: [string, string][] = [
  ["orgs_read", "orgs"],
  ["orgs_write", "orgs"],
  ["org_members_read", "org_members"],
  ["org_members_write", "org_members"],
  ["omc_rw", "org_member_creators"],
];

for (const [name, sql] of sources) {
  for (const [policy, table] of ORG_POLICIES) {
    const p = lastPolicy(sql, policy, table);
    check(`${name}: defines ${policy}`, !!p);
    // A direct read of another org table inside a policy re-enters that
    // table's RLS: orgs <-> org_members is the 42P17 recursion this fixes.
    check(`${name}: ${policy} reads no org table directly`, !/\b(from|join) public\.(orgs|org_members|org_member_creators)\b/.test(p!));
  }
  check(
    `${name}: orgs_read checks membership of THIS org via the definer helper, owner only while active`,
    /using \(\(owner_id = auth\.uid\(\) and public\.current_user_active\(\)\) or public\._is_org_member\(id\) or public\.is_admin\(\)\)/.test(lastPolicy(sql, "orgs_read", "orgs")!)
  );
  check(
    `${name}: orgs_write (create/rename/delete an org) needs an active owner`,
    /using \(\(owner_id = auth\.uid\(\) and public\.current_user_active\(\)\) or public\.is_admin\(\)\) with check \(\(owner_id = auth\.uid\(\) and public\.current_user_active\(\)\) or public\.is_admin\(\)\)/.test(
      lastPolicy(sql, "orgs_write", "orgs")!
    )
  );
  check(
    `${name}: a seat reads its own seat row only while active`,
    /using \(\(profile_id = auth\.uid\(\) and public\.current_user_active\(\)\) or public\._owns_org\(org_id\) or public\.is_admin\(\)\)/.test(
      lastPolicy(sql, "org_members_read", "org_members")!
    )
  );
  check(
    `${name}: org_members_write is owner (or admin) only, both ways`,
    /using \(public\._owns_org\(org_id\) or public\.is_admin\(\)\) with check \(public\._owns_org\(org_id\) or public\.is_admin\(\)\)/.test(
      lastPolicy(sql, "org_members_write", "org_members")!
    )
  );
  check(
    `${name}: omc_rw is seat-owner (or admin) only, both ways`,
    /using \(public\._owns_org_seat\(member_id\) or public\.is_admin\(\)\) with check \(public\._owns_org_seat\(member_id\) or public\.is_admin\(\)\)/.test(
      lastPolicy(sql, "omc_rw", "org_member_creators")!
    )
  );

  for (const helper of ["_owns_org", "_is_org_member", "_owns_org_seat"]) {
    const fn = lastFn(sql, helper);
    check(`${name}: defines ${helper}`, !!fn);
    // Like is_admin()/can_act_for(): a suspended caller has no org reach.
    check(`${name}: ${helper} requires the caller's profile to be active`, /join public\.profiles p on p\.id = [a-z]\.(owner_id|profile_id)[\s\S]*and p\.is_active/.test(fn!));
    check(`${name}: ${helper} is SECURITY DEFINER with a pinned search_path`, /security definer set search_path = public/.test(fn!));
    check(`${name}: ${helper} keys off auth.uid()`, /auth\.uid\(\)/.test(fn!));
    // RLS helpers stay callable by anon, or anon reads of these tables error.
    check(`${name}: ${helper} is not revoked`, !new RegExp(`revoke execute on function public\\.${helper}\\b`).test(sql));
  }

  const caf = lastFn(sql, "can_act_for");
  check(
    `${name}: can_act_for keeps the suspended 'view' for the caller's own account only`,
    /if target_creator = auth\.uid\(\) then return perm = 'view' or v_active; end if; if not v_active then return false; end if;/.test(caf!)
  );
  check(`${name}: can_act_for still requires the target to be in the seat's org`, /and p\.org_id = o\.id/.test(caf!));
  for (const fn of ["org_remove_member", "org_scope_creator"]) {
    check(`${name}: ${fn} checks the seat owner through the active-aware helper`, /if not public\._owns_org_seat\(p_member\) then return 'not_owner'; end if;/.test(lastFn(sql, fn)!));
  }
  check(
    `${name}: org_create refuses a suspended caller`,
    /if not public\.current_user_active\(\) then raise exception 'account is not active' using errcode = '42501'; end if;/.test(lastFn(sql, "org_create")!)
  );
  check(
    `${name}: org_invite_respond refuses a suspended invitee (accept and decline)`,
    /if not coalesce\(v_active, false\) then return 'inactive'; end if; select \* into v_inv/.test(lastFn(sql, "org_invite_respond")!)
  );
  // Not redefined by 0052 (they already go through _owns_org): check the
  // effective definitions in the full snapshots.
  if (name !== "migration 0052") {
    for (const fn of ["org_add_member", "org_remove_creator", "org_invite_creator"]) {
      check(`${name}: ${fn} is owner-guarded by _owns_org`, /if not public\._owns_org\(p_org\) then return 'not_owner'; end if;/.test(lastFn(sql, fn) ?? ""));
    }
    check(`${name}: org_invite_revoke is owner-guarded by _owns_org`, /public\._owns_org\(i\.org_id\)/.test(lastFn(sql, "org_invite_revoke") ?? ""));
    check(`${name}: org_invites_owner is owner-guarded by _owns_org`, /using \(public\._owns_org\(org_id\) or public\.is_admin\(\)\)/.test(lastPolicy(sql, "org_invites_owner", "org_invites") ?? ""));
  }

  const stats = lastFn(sql, "org_account_stats");
  check(`${name}: defines org_account_stats`, !!stats);
  check(
    `${name}: org_account_stats shows a seat only what can_act_for lets it view`,
    /where p\.org_id = p_org and \( public\._owns_org\(p_org\) or public\.is_admin\(\) or \(public\._is_org_member\(p_org\) and public\.can_act_for\(p\.id, 'view'\)\) \);/.test(stats!)
  );

  const ledger: [string, string, string][] = [
    ["fan_passes", "fan_passes_spins_granted_total_check", "spins_granted_total >= 0"],
    ["fans", "fans_spins_granted_total_check", "spins_granted_total >= 0"],
    ["fans", "fans_rl_count_check", "rl_count >= 0"],
    ["prizes", "prizes_stock_check", "stock >= 0"],
    ["prizes", "prizes_cost_cents_check", "cost_cents >= 0"],
  ];
  for (const [table, con, expr] of ledger) {
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    check(
      `${name}: adds ${con} NOT VALID`,
      new RegExp(`alter table public\\.${table} add constraint ${con} check \\(${esc(expr)}\\) not valid;`).test(sql)
    );
    const validate = sql.indexOf(`alter table public.${table} validate constraint ${con};`);
    const drop = sql.indexOf(`alter table public.${table} drop constraint ${con};`);
    check(`${name}: validates ${con} when clean`, validate > 0);
    check(`${name}: drops ${con} again (never leaves it NOT VALID) when rows violate it`, drop > validate);
  }
  check(
    `${name}: the fan aggregate CHECK waits for the per-pass CHECK`,
    /if v_bad = 0 and exists \(select 1 from pg_constraint where conname = 'fan_passes_spins_granted_total_check' and conrelid = 'public\.fan_passes'::regclass and convalidated\) then alter table public\.fans validate constraint fans_spins_granted_total_check;/.test(sql)
  );
  // Require the complete, unmodified 0052 block in each mirror. Later
  // migrations redefine org helpers and legitimately write reward stock;
  // checking their tail would misattribute those writes to historical 0052.
  const section = sources[0][1];
  check(`${name}: preserves the complete migration 0052 block`, sql.includes(section));
  check(`${name}: 0052 rewrites no ledger data`, !/update public\.(fan_passes|fans|prizes) set/.test(section));
}

const mig = sources[0][1];
check("0052 grants no table privileges", !/grant (select|insert|update|delete|all)/.test(mig));
check("0052 adds no wide-open policy", !/using \(true\)|with check \(true\)/.test(mig));
check("0052 leaves profiles_update (admin-only) alone", !/profiles_update/.test(mig));

// The runtime probe must stay wired into the drift check, and keep proving the
// cross-org case: a seat in the caller's OWN org scoped to a foreign creator
// grants nothing over that creator.
const drift = readFileSync(join(ROOT, "scripts", "db", "schema-drift-check.mjs"), "utf8");
check("drift check imports the org isolation probe", /import \{ ORG_PROBE_SQL, checkOrgProbe \} from "\.\/orgIsolationProbe\.mjs";/.test(drift));
check("drift check runs it on every build path", /for \(const db of \["ffa", "ffb", "ffc"\]\) \{\s*probeGrants\(db\);\s*probeOrgIsolation\(db\);/.test(drift));
check("drift check keeps the 0052 helpers anon-callable", /"_is_org_member\(uuid\)", "_owns_org_seat\(uuid\)"/.test(drift));
const probe = readFileSync(join(ROOT, "scripts", "db", "orgIsolationProbe.mjs"), "utf8");
for (const key of [
  '"m1.fans": "fan-c1,fan-c2"',
  '"ch.fans": "fan-c1"',
  '"ch.stats": email("C1")',
  '"out.insert.seat": RLS_REFUSED',
  '"out.join.org1": "ok:0"',
  '"out.invite.steal": "not_invitee"',
  '"out.act.c1.view": "false"',
  '"out.fans.after": ""',
  '"so1.rpc.add_member": "not_owner"',
  '"so1.rpc.create": "err:42501"',
  '"so1.update.org": "ok:0"',
  '"sch.fans": ""',
  '"sch.act.c1.view": "false"',
  '"scx.invite.accept": "inactive"',
  '"sc2.self.view": "true"',
]) {
  check(`org probe still expects ${key}`, probe.includes(key));
}

console.log(`orgRlsLedger0052: ${passed} checks passed`);
