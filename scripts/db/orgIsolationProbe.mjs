// @ts-check
// Agency / org isolation probe (audit A2). Run by schema-drift-check.mjs on
// every build path against a throwaway local Postgres, acting as real
// `authenticated` users through the live RLS policies and RPCs.
//
// Cast (all rolled back at the end):
//   ORG1 owned by O1 with creators C1, C2; seats: M1 (manager), CH (chatter,
//   scoped to C1 only). ORG2 owned by O2 with creator C3. CX is an independent
//   creator with a pending ORG1 invite. OUT is a signed-in non-member.
//
// It proves: a seat sees only creators its org manages (and a scoped seat only
// its scoped creators); a creator outside the org is unreachable; a non-member
// cannot add itself to an org, a seat, a seat scope, or another person's
// invite; a seat holder cannot widen its own role or scope; and a seat in the
// caller's OWN org scoped to a foreign creator grants nothing over that creator.
// Then it suspends O1, CH, CX and C2 (seat, invitee and creator checks run
// before the owner's, so a wrongly allowed owner write can't mask them): a
// suspended owner is refused every
// management action (RPCs and direct writes) and reads nothing of the org; a
// suspended seat gets nothing; a suspended invitee can't join; a suspended
// creator keeps only the read-only view of its own account.

const id = (n) => `00000000-0000-4000-8000-0000000520${n}`;
export const U = {
  O1: id("a1"), M1: id("a2"), CH: id("a3"), C1: id("a4"), C2: id("a5"),
  O2: id("b1"), C3: id("b2"), CX: id("c1"), OUT: id("c2"),
};
const ORG1 = id("f1");
const ORG2 = id("f2");
const SEAT_M1 = id("e1");
const SEAT_CH = id("e2");
const INV = id("d1");
const email = (k) => `probe-0052-${k.toLowerCase()}@example.test`;

const q = (s) => `'${s.replace(/'/g, "''")}'`;
// Run `stmts` as the signed-in user `uid`, then drop back to the superuser.
const as = (uid, stmts) =>
  `set local role authenticated; select set_config('request.jwt.claim.sub', '${uid}', true);\n${stmts}\nreset role;`;
// Emit `key=value`. try() never aborts the transaction: a refused statement
// reports err:<sqlstate>, a DML reports ok:<rowcount>. val() returns a query's
// single text value ('' for no rows) or err:<sqlstate>.
const val = (key, sql) => `select 'P|${key}=' || ffprobe.val(${q(sql)});`;
const tryq = (key, sql) => `select 'P|${key}=' || ffprobe.try(${q(sql)});`;
const names = (where = "true") =>
  `select coalesce(string_agg(display_name, ',' order by display_name), '') from public.fans where ${where}`;

export const ORG_PROBE_SQL = `
begin;
create schema ffprobe;
grant usage on schema ffprobe to authenticated;
create function ffprobe.try(stmt text) returns text language plpgsql as $f$
declare n bigint;
begin
  execute stmt;
  get diagnostics n = row_count;
  return 'ok:' || n;
exception when others then
  return 'err:' || sqlstate;
end $f$;
create function ffprobe.val(stmt text) returns text language plpgsql as $f$
declare v text;
begin
  execute stmt into v;
  return coalesce(v, '');
exception when others then
  return 'err:' || sqlstate;
end $f$;
grant execute on all functions in schema ffprobe to authenticated;
-- Supabase's default privileges give authenticated these table grants (RLS is
-- the gate); the local stub does not, so mirror them for this transaction.
grant select, insert, update, delete on all tables in schema public to authenticated;

insert into auth.users (id, email) values
${Object.entries(U).map(([k, v]) => `  ('${v}', '${email(k)}')`).join(",\n")};
update public.profiles set is_active = true where id in (${Object.values(U).map((v) => `'${v}'`).join(", ")});
insert into public.orgs (id, name, owner_id) values ('${ORG1}', 'Org1', '${U.O1}'), ('${ORG2}', 'Org2', '${U.O2}');
insert into public.org_members (id, org_id, profile_id, role) values
  ('${SEAT_M1}', '${ORG1}', '${U.M1}', 'manager'),
  ('${SEAT_CH}', '${ORG1}', '${U.CH}', 'chatter');
insert into public.org_member_creators (member_id, creator_id) values ('${SEAT_CH}', '${U.C1}');
update public.profiles set org_id = '${ORG1}' where id in ('${U.C1}', '${U.C2}');
update public.profiles set org_id = '${ORG2}' where id = '${U.C3}';
insert into public.fans (creator_id, display_name) values
  ('${U.C1}', 'fan-c1'), ('${U.C2}', 'fan-c2'), ('${U.C3}', 'fan-c3'), ('${U.CX}', 'fan-cx');
insert into public.org_invites (id, org_id, email, status) values ('${INV}', '${ORG1}', '${email("CX")}', 'pending');

${as(U.M1, [
  val("m1.fans", names()),
  val("m1.orgs", "select coalesce(string_agg(name, ',' order by name), '') from public.orgs"),
  val("m1.stats", `select coalesce(string_agg(email, ',' order by email), '') from public.org_account_stats('${ORG1}')`),
  val("m1.act.c1.manage", `select public.can_act_for('${U.C1}', 'manage')::text`),
  val("m1.act.c3.view", `select public.can_act_for('${U.C3}', 'view')::text`),
  val("m1.act.cx.view", `select public.can_act_for('${U.CX}', 'view')::text`),
  tryq("m1.insert.fan.c3", `insert into public.fans (creator_id, display_name) values ('${U.C3}', 'planted')`),
  tryq("m1.update.fan.cx", `update public.fans set display_name = 'hacked' where creator_id = '${U.CX}'`),
].join("\n"))}

${as(U.CH, [
  val("ch.fans", names()),
  val("ch.seats", "select coalesce(string_agg(role::text, ',' order by role), '') from public.org_members"),
  val("ch.stats", `select coalesce(string_agg(email, ',' order by email), '') from public.org_account_stats('${ORG1}')`),
  val("ch.act.c2.view", `select public.can_act_for('${U.C2}', 'view')::text`),
  tryq("ch.self.promote", `update public.org_members set role = 'owner' where id = '${SEAT_CH}'`),
  tryq("ch.self.scope", `insert into public.org_member_creators (member_id, creator_id) values ('${SEAT_CH}', '${U.C2}')`),
  val("ch.rpc.scope", `select public.org_scope_creator('${SEAT_CH}', '${U.C2}', true)`),
].join("\n"))}

${as(U.O1, [
  val("o1.seats", "select coalesce(string_agg(role::text, ',' order by role), '') from public.org_members"),
  val("o1.orgs", "select coalesce(string_agg(name, ',' order by name), '') from public.orgs"),
].join("\n"))}

${as(U.O2, [
  val("o2.orgs", "select coalesce(string_agg(name, ',' order by name), '') from public.orgs"),
  val("o2.org1.seats", `select count(*)::text from public.org_members where org_id = '${ORG1}'`),
  val("o2.org1.stats", `select count(*)::text from public.org_account_stats('${ORG1}')`),
  val("o2.org1.invites", `select count(*)::text from public.org_invites where org_id = '${ORG1}'`),
].join("\n"))}

${as(U.OUT, [
  val("out.fans", names()),
  val("out.orgs", "select coalesce(string_agg(name, ',' order by name), '') from public.orgs"),
  val("out.seats", "select count(*)::text from public.org_members"),
  val("out.stats", `select count(*)::text from public.org_account_stats('${ORG1}')`),
  tryq("out.insert.seat", `insert into public.org_members (org_id, profile_id, role) values ('${ORG1}', '${U.OUT}', 'owner')`),
  tryq("out.insert.org1", `insert into public.orgs (id, name, owner_id) values ('${ORG1}', 'Org1', '${U.OUT}') on conflict (id) do update set owner_id = excluded.owner_id`),
  tryq("out.take.org1", `update public.orgs set owner_id = '${U.OUT}' where id = '${ORG1}'`),
  val("out.rpc.add_member", `select public.org_add_member('${ORG1}', '${email("OUT")}', 'owner')`),
  val("out.rpc.scope", `select public.org_scope_creator('${SEAT_CH}', '${U.C2}', true)`),
  tryq("out.insert.scope", `insert into public.org_member_creators (member_id, creator_id) values ('${SEAT_CH}', '${U.C2}')`),
  tryq("out.join.org1", `update public.profiles set org_id = '${ORG1}' where id = '${U.OUT}'`),
  val("out.invite.steal", `select public.org_invite_respond('${INV}', true)`),
  // OUT's own org + an owner seat for itself, scoped to ORG1's creator C1:
  // still nothing over C1, because C1 is not in OUT's org.
  val("out.own.org", "select (public.org_create('Out org') is not null)::text"),
  val("out.own.seat", `select public.org_add_member((select id from public.orgs where owner_id = '${U.OUT}'), '${email("OUT")}', 'owner')`),
  val("out.own.scope", `select public.org_scope_creator((select id from public.org_members where profile_id = '${U.OUT}'), '${U.C1}', true)`),
  val("out.act.c1.view", `select public.can_act_for('${U.C1}', 'view')::text`),
  val("out.act.c1.manage", `select public.can_act_for('${U.C1}', 'manage')::text`),
  val("out.fans.after", names()),
].join("\n"))}

-- Suspend the org owner O1, the chatter seat CH, the invitee CX and creator C2.
update public.profiles set is_active = false where id in ('${U.O1}', '${U.CH}', '${U.CX}', '${U.C2}');

${as(U.CH, [
  val("sch.fans", names()),
  val("sch.act.c1.view", `select public.can_act_for('${U.C1}', 'view')::text`),
  val("sch.orgs", "select count(*)::text from public.orgs"),
  val("sch.seats", "select count(*)::text from public.org_members"),
  val("sch.stats", `select count(*)::text from public.org_account_stats('${ORG1}')`),
].join("\n"))}

${as(U.CX, [
  val("scx.invite.accept", `select public.org_invite_respond('${INV}', true)`),
  val("scx.invite.decline", `select public.org_invite_respond('${INV}', false)`),
].join("\n"))}

${as(U.C2, [
  val("sc2.self.view", `select public.can_act_for('${U.C2}', 'view')::text`),
  val("sc2.self.manage", `select public.can_act_for('${U.C2}', 'manage')::text`),
  val("sc2.fans", names()),
].join("\n"))}

${as(U.O1, [
  val("so1.rpc.add_member", `select public.org_add_member('${ORG1}', '${email("OUT")}', 'analyst')`),
  val("so1.rpc.remove_member", `select public.org_remove_member('${SEAT_M1}')`),
  val("so1.rpc.scope", `select public.org_scope_creator('${SEAT_CH}', '${U.C2}', true)`),
  val("so1.rpc.invite", `select public.org_invite_creator('${ORG1}', '${email("OUT")}')`),
  val("so1.rpc.revoke", `select public.org_invite_revoke('${INV}')`),
  val("so1.rpc.remove_creator", `select public.org_remove_creator('${ORG1}', '${U.C2}')`),
  val("so1.rpc.create", "select public.org_create('Another org')::text"),
  tryq("so1.insert.seat", `insert into public.org_members (org_id, profile_id, role) values ('${ORG1}', '${U.OUT}', 'owner')`),
  tryq("so1.delete.seat", `delete from public.org_members where id = '${SEAT_M1}'`),
  tryq("so1.insert.scope", `insert into public.org_member_creators (member_id, creator_id) values ('${SEAT_CH}', '${U.C2}')`),
  tryq("so1.update.org", `update public.orgs set name = 'Renamed' where id = '${ORG1}'`),
  tryq("so1.delete.org", `delete from public.orgs where id = '${ORG1}'`),
  tryq("so1.insert.org", `insert into public.orgs (name, owner_id) values ('Another org', '${U.O1}')`),
  val("so1.orgs", "select count(*)::text from public.orgs"),
  val("so1.seats", "select count(*)::text from public.org_members"),
  val("so1.invites", "select count(*)::text from public.org_invites"),
  val("so1.stats", `select count(*)::text from public.org_account_stats('${ORG1}')`),
].join("\n"))}

select 'P|after.org1.name=' || name from public.orgs where id = '${ORG1}';
select 'P|after.orgs.o1=' || count(*) from public.orgs where owner_id = '${U.O1}';
select 'P|after.org1.seats=' || string_agg(p.email || ':' || m.role, ',' order by p.email) from public.org_members m join public.profiles p on p.id = m.profile_id where m.org_id = '${ORG1}';
select 'P|after.ch.scope=' || string_agg(creator_id::text, ',') from public.org_member_creators where member_id = '${SEAT_CH}';
select 'P|after.org1.owner=' || (owner_id = '${U.O1}')::text from public.orgs where id = '${ORG1}';
select 'P|after.out.org=' || coalesce(org_id::text, 'none') from public.profiles where id = '${U.OUT}';
select 'P|after.cx=' || coalesce(org_id::text, 'none') || ':' || (select status from public.org_invites where id = '${INV}') from public.profiles where id = '${U.CX}';
select 'P|after.fans=' || string_agg(display_name, ',' order by display_name) from public.fans;
rollback;
`;

// 42501 = insufficient_privilege, which Postgres raises for an RLS WITH CHECK
// violation. An RLS UPDATE that matches no visible row is ok:0 (a no-op).
const RLS_REFUSED = "err:42501";
export const ORG_PROBE_EXPECT = {
  "m1.fans": "fan-c1,fan-c2",
  "m1.orgs": "Org1",
  "m1.stats": `${email("C1")},${email("C2")}`,
  "m1.act.c1.manage": "true",
  "m1.act.c3.view": "false",
  "m1.act.cx.view": "false",
  "m1.insert.fan.c3": RLS_REFUSED,
  "m1.update.fan.cx": "ok:0",
  "ch.fans": "fan-c1",
  "ch.seats": "chatter",
  "ch.stats": email("C1"),
  "ch.act.c2.view": "false",
  "ch.self.promote": "ok:0",
  "ch.self.scope": RLS_REFUSED,
  "ch.rpc.scope": "not_owner",
  "o1.seats": "manager,chatter",
  "o1.orgs": "Org1",
  "o2.orgs": "Org2",
  "o2.org1.seats": "0",
  "o2.org1.stats": "0",
  "o2.org1.invites": "0",
  "out.fans": "",
  "out.orgs": "",
  "out.seats": "0",
  "out.stats": "0",
  "out.insert.seat": RLS_REFUSED,
  "out.insert.org1": RLS_REFUSED,
  "out.take.org1": "ok:0",
  "out.rpc.add_member": "not_owner",
  "out.rpc.scope": "not_owner",
  "out.insert.scope": RLS_REFUSED,
  "out.join.org1": "ok:0",
  "out.invite.steal": "not_invitee",
  "out.own.org": "true",
  "out.own.seat": "ok",
  "out.own.scope": "ok",
  "out.act.c1.view": "false",
  "out.act.c1.manage": "false",
  "out.fans.after": "",
  // A suspended owner is refused every management action and sees nothing.
  "so1.rpc.add_member": "not_owner",
  "so1.rpc.remove_member": "not_owner",
  "so1.rpc.scope": "not_owner",
  "so1.rpc.invite": "not_owner",
  "so1.rpc.revoke": "not_owner",
  "so1.rpc.remove_creator": "not_owner",
  "so1.rpc.create": "err:42501",
  "so1.insert.seat": RLS_REFUSED,
  "so1.delete.seat": "ok:0",
  "so1.insert.scope": RLS_REFUSED,
  "so1.update.org": "ok:0",
  "so1.delete.org": "ok:0",
  "so1.insert.org": RLS_REFUSED,
  "so1.orgs": "0",
  "so1.seats": "0",
  "so1.invites": "0",
  "so1.stats": "0",
  // A suspended seat gets nothing.
  "sch.fans": "",
  "sch.act.c1.view": "false",
  "sch.orgs": "0",
  "sch.seats": "0",
  "sch.stats": "0",
  // A suspended invitee can't join (or decline).
  "scx.invite.accept": "inactive",
  "scx.invite.decline": "inactive",
  // A suspended creator keeps a read-only view of its OWN account.
  "sc2.self.view": "true",
  "sc2.self.manage": "false",
  "sc2.fans": "fan-c2",
  "after.org1.name": "Org1",
  "after.orgs.o1": "1",
  "after.org1.seats": `${email("CH")}:chatter,${email("M1")}:manager`,
  "after.ch.scope": U.C1,
  "after.org1.owner": "true",
  "after.out.org": "none",
  "after.cx": "none:pending",
  "after.fans": "fan-c1,fan-c2,fan-c3,fan-cx",
};

/** Compare the probe's `P|key=value` lines with the expectations; returns the mismatches. */
export function checkOrgProbe(stdout) {
  const got = new Map();
  for (const line of stdout.split("\n")) {
    const m = /^P\|([^=]+)=(.*)$/.exec(line.trim());
    if (m) got.set(m[1], m[2]);
  }
  const bad = [];
  for (const [key, want] of Object.entries(ORG_PROBE_EXPECT)) {
    const have = got.get(key);
    if (have !== want) bad.push(`${key}: expected ${JSON.stringify(want)}, got ${have === undefined ? "nothing" : JSON.stringify(have)}`);
  }
  return bad;
}
