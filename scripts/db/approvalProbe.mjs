// Approval is a database authorization boundary, not only a dashboard redirect.
// This local-only transaction runs as authenticated callers through the actual
// RLS policies/RPCs, then rolls back every fixture. Imported by the drift check.
const uid = (n) => `00000000-0000-4000-8000-${String(560000 + n).padStart(12, '0')}`;
const U = { pending: uid(1), rejected: uid(2), approved: uid(3), inactive: uid(4), admin: uid(5), owner: uid(6), manager: uid(7), chatter: uid(8), creator: uid(9), outside: uid(10), pendingseat: uid(11), pendingowner: uid(12), pendingtarget: uid(13), invitee: uid(14) };
const ORG = uid(80), PENDING_ORG = uid(81), OWNER_SEAT = uid(82), MANAGER_SEAT = uid(83), CHATTER_SEAT = uid(84), PENDING_SEAT = uid(85);
const email = (name) => `approval-${name}@example.test`;
const q = (s) => `'${s.replaceAll("'", "''")}'`;
const val = (key, statement) => `select 'P|' || ${q(key)} || '=' || ffapproval.val(${q(statement)});`;
const attempt = (key, statement) => `select 'P|' || ${q(key)} || '=' || ffapproval.attempt(${q(statement)});`;
const as = (name, statements, aal = 'aal1') => `set local role authenticated; select set_config('request.jwt.claim.sub', '${U[name]}', true); select set_config('request.jwt.claims', '{"aal":"${aal}"}', true);\n${statements.join('\n')}\nreset role;`;
const EXPECT = {};
const lines = [];
function value(key, statement, expected) { EXPECT[key] = expected; return val(key, statement); }
function change(key, statement, expected) { EXPECT[key] = expected; return attempt(key, statement); }
const wheel = (name) => uid(100 + Object.keys(U).indexOf(name));
const fanImport = (name) => JSON.stringify([{ fan_id: uid(name === 'pending' ? 201 : 202), pass_id: uid(name === 'pending' ? 211 : 212), token: `approval-import-${name}`, wheel_id: wheel(name), campaign_id: null, name: 'Unapproved import', spins: 2, amount_cents: 0 }]);

for (const name of ['pending', 'rejected', 'approved', 'inactive']) {
  const allowed = name === 'approved';
  lines.push(as(name, [
    value(`${name}.active`, 'select public.current_user_active()::text', String(allowed)),
    value(`${name}.self.view`, `select public.can_act_for('${U[name]}', 'view')::text`, 'true'),
    value(`${name}.self.edit`, `select public.can_act_for('${U[name]}', 'edit_wheel')::text`, String(allowed)),
    change(`${name}.own.insert`, `insert into public.wheels(creator_id,title) values ('${U[name]}','new-own-wheel')`, allowed ? 'ok:1' : 'err:42501'),
    change(`${name}.own.update`, `update public.wheels set title='changed-own-wheel' where creator_id='${U[name]}'`, allowed ? 'ok:2' : 'ok:0'),
    change(`${name}.cross.insert`, `insert into public.wheels(creator_id,title) values ('${U.outside}','cross-tenant')`, 'err:42501'),
    change(`${name}.push.insert`, `insert into public.push_subscriptions(user_id,endpoint,p256dh,auth) values ('${U[name]}','https://fcm.googleapis.com/fcm/send/approval-${name}','key','auth')`, allowed ? 'ok:1' : 'err:42501'),
    value(`${name}.org.create`, "select (public.org_create('Approval-created org') is not null)::text", allowed ? 'true' : 'err:42501'),
  ]));
}
for (const name of ['pending', 'rejected']) {
  lines.push(as(name, [
    change(`${name}.import`, `select public.import_fans('${fanImport(name)}'::jsonb)`, 'err:42501'),
    change(`${name}.profile.rpc`, `select public.set_public_profile('approval-${name}',null,null)`, 'ok:1'),
    change(`${name}.application`, `insert into public.creator_applications(profile_id,email) values ('${U[name]}','${email(name)}')`, 'ok:1'),
    change(`${name}.display_name`, "select public.set_display_name('Application name')", 'ok:1'),
    value(`${name}.invite.accept`, `select public.org_invite_respond('${uid(name === 'pending' ? 300 : 301)}',true)`, 'inactive'),
    value(`${name}.invite.decline`, `select public.org_invite_respond('${uid(name === 'pending' ? 300 : 301)}',false)`, 'inactive'),
  ]));
  lines.push(value(`${name}.import.rows`, `select count(*)::text from public.fans where creator_id='${U[name]}'`, '0'));
  lines.push(value(`${name}.profile.unchanged`, `select (public_slug is null)::text from public.profiles where id='${U[name]}'`, 'true'));
  lines.push(value(`${name}.name.changed`, `select (display_name='Application name')::text from public.profiles where id='${U[name]}'`, 'true'));
}
for (const aal of ['aal1', 'aal2']) {
  lines.push(as('admin', [
    value(`admin.${aal}.active`, 'select public.current_user_active()::text', 'true'),
    value(`admin.${aal}.is_admin`, 'select public.is_admin()::text', String(aal === 'aal2')),
    change(`admin.${aal}.own.insert`, `insert into public.wheels(creator_id,title) values ('${U.admin}','legacy-admin-own')`, 'ok:1'),
    change(`admin.${aal}.cross.insert`, `insert into public.wheels(creator_id,title) values ('${U.outside}','admin-cross')`, aal === 'aal2' ? 'ok:1' : 'err:42501'),
  ], aal));
}
lines.push(`update public.profiles set approval_status='rejected' where id='${U.admin}';`);
lines.push(as('admin', [value('admin.legacy.rejected.active', 'select public.current_user_active()::text', 'true')], 'aal1'));
for (const name of ['owner', 'manager', 'chatter', 'pendingseat']) {
  const approved = name !== 'pendingseat';
  const edit = approved && name !== 'chatter';
  lines.push(as(name, [
    value(`${name}.target.view`, `select public.can_act_for('${U.creator}','view')::text`, String(approved)),
    value(`${name}.target.edit`, `select public.can_act_for('${U.creator}','edit_wheel')::text`, String(edit)),
    value(`${name}.target.chat`, `select public.can_act_for('${U.creator}','chat')::text`, String(approved)),
    change(`${name}.target.insert`, `insert into public.wheels(creator_id,title) values ('${U.creator}','seat-edit')`, edit ? 'ok:1' : 'err:42501'),
    value(`${name}.pendingtarget.edit`, `select public.can_act_for('${U.pendingtarget}','edit_wheel')::text`, 'false'),
    change(`${name}.pendingtarget.insert`, `insert into public.wheels(creator_id,title) values ('${U.pendingtarget}','seat-unapproved-target')`, 'err:42501'),
    value(`${name}.outside.view`, `select public.can_act_for('${U.outside}','view')::text`, 'false'),
  ]));
}
lines.push(as('pendingseat', [value('pendingseat.member', `select public._is_org_member('${ORG}')::text`, 'false')]));
lines.push(as('pendingowner', [
  value('pendingowner.owns', `select public._owns_org('${PENDING_ORG}')::text`, 'false'),
  value('pendingowner.seat.owns', `select public._owns_org_seat('${PENDING_SEAT}')::text`, 'false'),
  value('pendingowner.add', `select public.org_add_member('${PENDING_ORG}','${email('outside')}','manager')`, 'not_owner'),
]));
lines.push(as('owner', [
  value('owner.add.pending', `select public.org_add_member('${ORG}','${email('pending')}','manager')`, 'no_such_user'),
  value('owner.invite.pending', `select public.org_invite_creator('${ORG}','${email('pending')}')`, 'no_such_user'),
]));
lines.push(as('invitee', [value('approved.invite.accept', `select public.org_invite_respond('${uid(302)}',true)`, 'ok')]));
for (const state of ['pending', 'rejected', 'inactive']) {
  lines.push(`update public.profiles set approval_status='${state === 'inactive' ? 'approved' : state}',is_active=${state !== 'inactive'} where id='${U.owner}';`);
  lines.push(as('manager', [
    value(`owner.${state}.manager.edit`, `select public.can_act_for('${U.creator}','edit_wheel')::text`, 'false'),
    value(`owner.${state}.manager.member`, `select public._is_org_member('${ORG}')::text`, 'false'),
  ]));
  lines.push(as('outside', [value(`owner.${state}.invite.accept`, `select public.org_invite_respond('${uid(303)}',true)`, 'inactive')]));
}
lines.push(`update public.profiles set approval_status='approved',is_active=true where id='${U.owner}';`);
lines.push(as('manager', [value('owner.restored.manager.edit', `select public.can_act_for('${U.creator}','edit_wheel')::text`, 'true')]));
lines.push(`update public.profiles set is_active=false where id='${U.manager}';`);
lines.push(as('manager', [value('suspended.manager.edit', `select public.can_act_for('${U.creator}','edit_wheel')::text`, 'false'), change('suspended.manager.insert', `insert into public.wheels(creator_id,title) values ('${U.creator}','suspended-seat')`, 'err:42501')]));

export const APPROVAL_PROBE_SQL = `begin;
create schema ffapproval;
grant usage on schema ffapproval to authenticated;
create function ffapproval.val(stmt text) returns text language plpgsql as $f$ declare v text; begin execute stmt into v; return coalesce(v,''); exception when others then return 'err:'||sqlstate; end; $f$;
create function ffapproval.attempt(stmt text) returns text language plpgsql as $f$ declare n bigint; begin execute stmt; get diagnostics n=row_count; return 'ok:'||n; exception when others then return 'err:'||sqlstate; end; $f$;
grant execute on all functions in schema ffapproval to authenticated;
-- Match Supabase's ordinary table grants; RLS remains the authorization gate.
grant select,insert,update,delete on public.profiles,public.wheels,public.fans,public.orgs,public.org_members,public.org_member_creators,public.creator_applications to authenticated;
insert into auth.users(id,email) values ${Object.entries(U).map(([name,id])=>`('${id}','${email(name)}')`).join(',')};
update public.profiles set approval_status='approved' where id in (${['approved','inactive','owner','manager','chatter','creator','outside','invitee'].map(n=>`'${U[n]}'`).join(',')});
update public.profiles set approval_status='rejected' where id='${U.rejected}';
update public.profiles set is_active=false where id='${U.inactive}';
update public.profiles set role='admin' where id='${U.admin}';
insert into public.orgs(id,name,owner_id) values ('${ORG}','Approved owner org','${U.owner}'),('${PENDING_ORG}','Pending owner org','${U.pendingowner}');
update public.profiles set org_id='${ORG}' where id in ('${U.creator}','${U.pendingtarget}');
insert into public.org_members(id,org_id,profile_id,role) values ('${OWNER_SEAT}','${ORG}','${U.owner}','owner'),('${MANAGER_SEAT}','${ORG}','${U.manager}','manager'),('${CHATTER_SEAT}','${ORG}','${U.chatter}','chatter'),('${PENDING_SEAT}','${PENDING_ORG}','${U.pendingseat}','manager'),('${uid(86)}','${ORG}','${U.pendingseat}','manager');
insert into public.org_member_creators(member_id,creator_id) values ('${CHATTER_SEAT}','${U.creator}');
insert into public.wheels(id,creator_id,title) values ${Object.keys(U).map(name=>`('${wheel(name)}','${U[name]}','seed-${name}')`).join(',')};
insert into public.org_invites(id,org_id,email,status) values ('${uid(300)}','${ORG}','${email('pending')}','pending'),('${uid(301)}','${ORG}','${email('rejected')}','pending'),('${uid(302)}','${ORG}','${email('invitee')}','pending'),('${uid(303)}','${ORG}','${email('outside')}','pending');
${lines.join('\n')}
rollback;`;
export const APPROVAL_PROBE_EXPECT = Object.freeze(EXPECT);
export function checkApprovalProbe(stdout) {
  const got = new Map(stdout.split('\n').map(line=>/^P\|([^=]+)=(.*)$/.exec(line.trim())).filter(Boolean).map(m=>[m[1],m[2]]));
  return Object.entries(APPROVAL_PROBE_EXPECT).filter(([key,want])=>got.get(key)!==want).map(([key,want])=>`${key}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got.get(key))}`);
}
