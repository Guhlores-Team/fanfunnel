// @ts-check
// 0062: real RLS/SQL checks on disposable local PostgreSQL only.
import { randomUUID } from 'node:crypto';
const id=n=>`00000000-0000-4000-8000-0000000062${n}`;
const A=id('a0'),B=id('b0'),C=id('c0'),ADM=id('d0'),ADM2=id('d1'),OFF=id('d2'),ORG=id('e0'),ORG2=id('e1'),W=id('f0');
// Observed-wait barriers (storageWorkProbe.mjs pattern): a holder renames itself
// once its row is held and keeps it until it sees the other session blocked on a
// lock. pg_stat_activity is frozen per transaction: clear the snapshot each poll.
// The only timers left are hang guards and poll intervals.
const seen=(name,condition='')=>`do $$ begin for i in 1..1500 loop perform pg_stat_clear_snapshot(); exit when exists(select 1 from pg_stat_activity where application_name='${name}'${condition}); perform pg_sleep(0.01); end loop; end $$;`;
const blocked=name=>seen(name," and wait_event_type='Lock'");
const jwt=(uid,body,aal='aal1')=>`set local role authenticated; select set_config('request.jwt.claim.sub','${uid}',true); select set_config('request.jwt.claims','{"sub":"${uid}","role":"authenticated","aal":"${aal}"}',true); ${body} reset role;`;
// 0072: admin_reserve_account_deletion is service-only (no app caller); its
// own admin check still reads the caller's claims.
const svcJwt=(uid,body,aal='aal1')=>`set local role service_role; select set_config('request.jwt.claim.sub','${uid}',true); select set_config('request.jwt.claims','{"sub":"${uid}","role":"authenticated","aal":"${aal}"}',true); ${body} reset role;`;
const seed=`grant usage on schema public,auth to authenticated,anon,service_role; grant select,insert,update,delete on public.profiles,public.wheels to authenticated; grant select on public.org_invites to authenticated; grant select on public.wheels to service_role;
insert into auth.users(id,email,email_confirmed_at) values('${A}','security-a@example.test',now()),('${B}','security-b@example.test',now()),('${C}','security-c@example.test',now()),('${ADM}','security-admin@example.test',now()),('${ADM2}','security-admin2@example.test',now()),('${OFF}','security-inactive@example.test',now());
update public.profiles set is_active=true,approval_status='approved' where id in('${A}','${B}','${C}','${ADM}','${ADM2}','${OFF}');
update public.profiles set role='admin' where id in('${ADM}','${ADM2}','${OFF}'); update public.profiles set is_active=false where id='${OFF}';
insert into public.orgs(id,name,owner_id) values('${ORG}','Security agency','${B}'),('${ORG2}','Second agency','${ADM2}');
insert into public.wheels(id,creator_id,title) values('${W}','${A}','Before MFA');`;
/** @param {string} db @param {Function} psql @param {Function} psqlAsync */
export async function probeAccountSecurity(db,psql,psqlAsync) {
 const bad=[];let checks=0;
 const run=body=>psql(db,['-c',`begin; ${seed} ${body} rollback;`],{allowFail:true});
 const expect=(label,body,wants)=>{const r=run(body),lines=r.stdout.split('\n').map(s=>s.trim());checks++;if(r.status!==0||wants.some(s=>!lines.includes(s)))bad.push(`${label}: ${r.stderr.trim()||r.stdout.trim()}`);};
 const deny=(label,body,pattern=/permission denied|row-level security/)=>{const r=run(body);checks++;if(r.status===0||!pattern.test(r.stderr))bad.push(`${label}: not refused (${r.stderr.trim()||r.stdout.trim()})`);};
 const factor=`insert into auth.mfa_factors(user_id,status) values('${A}','verified');`;
 expect('unenrolled/unverified remain optional',`${jwt(A,`select 'optional:'||public.current_user_active(); select 'own:'||public.can_act_for('${A}','edit_wheel');`)} insert into auth.mfa_factors(user_id,status) values('${A}','unverified'); ${jwt(A,`select 'unverified:'||public.current_user_active();`)}`,['optional:true','own:true','unverified:true']);
 // 0071: sign-up never copies the e-mail into display_name, so A's name stays
 // empty; a rename that slipped past the aal1 refusal would read 'Forbidden'.
 expect('verified aal1 business access refused',`${factor} ${jwt(A,`select 'active:'||public.current_user_active(); select 'view:'||public.can_act_for('${A}','view'); select 'write:'||public.can_act_for('${A}','edit_wheel'); select 'rows:'||count(*) from public.wheels where id='${W}'; update public.wheels set title='Forbidden' where id='${W}'; select public.set_display_name('Forbidden');`)} select 'title:'||title from public.wheels where id='${W}'; select 'name:'||coalesce(display_name,'') from public.profiles where id='${A}';`,['active:false','view:false','write:false','rows:0','title:Before MFA','name:']);
 expect('metadata and bypass GUC cannot substitute for challenge',`${factor} update auth.users set raw_user_meta_data='{"aal":"aal2","role":"admin","mfa_verified":true}' where id='${A}'; select set_config('app.mfa.bypass','true',true); ${jwt(A,`select 'forged:'||public.current_user_active();`)}`,['forged:false']);
 expect('verified aal2 restores own access only',`${factor} ${jwt(A,`select 'active:'||public.current_user_active(); update public.wheels set title='After MFA' where id='${W}'; select 'other:'||public.can_act_for('${B}','edit_wheel');`,'aal2')} select 'title:'||title from public.wheels where id='${W}';`,['active:true','other:false','title:After MFA']);
 for(const role of ['anon','authenticated']) {
   deny(`${role} cannot write factor state`,`set local role ${role}; insert into auth.mfa_factors(user_id,status) values('${A}','verified');`);
   deny(`${role} cannot invoke hidden MFA helper`,`set local role ${role}; select public._session_mfa_satisfied();`,/permission denied for function/);
   for(const fn of ['_serialize_active_admins','_preserve_active_admin']) expect(`${role} cannot invoke ${fn}`,`select 'grant:'||has_function_privilege('${role}','public.${fn}()','EXECUTE');`,['grant:false']);
 }
 expect('agency identity MFA, not target creator MFA',`${factor} insert into public.org_members(org_id,profile_id,role) values('${ORG}','${A}','manager'); update public.profiles set org_id='${ORG}' where id='${C}'; ${jwt(A,`select 'agency-low:'||public.can_act_for('${C}','grant'); select 'org-low:'||public._is_org_member('${ORG}');`)} ${jwt(A,`select 'agency-high:'||public.can_act_for('${C}','grant');`,'aal2')}`,['agency-low:false','org-low:false','agency-high:true']);
 expect('service maintenance remains independent',`${factor} set local role service_role; select 'service:'||count(*) from public.wheels where id='${W}'; select 'creator-reserve:'||public.reserve_self_account_deletion('${A}'); reset role;`,['service:1','creator-reserve:ok']);
 for(const sql of [`update public.profiles set role='creator' where id='${ADM}';`,`update public.profiles set is_active=false where id='${ADM}';`,`delete from public.profiles where id='${ADM}';`,`delete from auth.users where id='${ADM}';`]) deny('last ACTIVE admin guarded despite inactive admins',`update public.profiles set is_active=false where id='${ADM2}'; ${sql}`,/last_active_admin/);
 expect('both reservations count active admins',`update public.profiles set is_active=false where id='${ADM2}'; select 'last:'||public.reserve_self_account_deletion('${ADM}'); ${svcJwt(ADM,`select 'inactive:'||public.admin_reserve_account_deletion('${ADM2}'); select 'self:'||public.admin_reserve_account_deletion('${ADM}');`,'aal2')} select 'kept:'||role||':'||is_active from public.profiles where id='${ADM}';`,['last:last_admin','inactive:ok','self:cannot_delete_self','kept:admin:true']);
 deny('an aal2 admin session cannot reserve a deletion directly (0072)',jwt(ADM,`select public.admin_reserve_account_deletion('${ADM2}');`,'aal2'),/permission denied for function admin_reserve_account_deletion/);
 expect('two active admins allow one reservation only',`select 'first:'||public.reserve_self_account_deletion('${ADM}'); select 'second:'||public.reserve_self_account_deletion('${ADM2}');`,['first:ok','second:last_admin']);
 expect('ordinary failed deletion still restores',`select public.creator_storage_account('begin','${ADM}',p_actor=>'${ADM}'); select public.creator_storage_account('claim','${ADM}',p_worker=>'${W}'); select public.creator_storage_account('pause','${ADM}',p_worker=>'${W}',p_error=>'storage_cleanup_failed'); select 'restored:'||role||':'||is_active from public.profiles where id='${ADM}';`,['restored:admin:true']);
 expect('last admin storage begin remains non-destructive',`update public.profiles set is_active=false where id='${ADM2}'; select 'begin:'||(public.creator_storage_account('begin','${ADM}',p_actor=>'${ADM}')->>'error'); select 'kept:'||is_active from public.profiles where id='${ADM}';`,['begin:last_admin','kept:true']);
 const send=jwt(B,`select public.org_invite_creator('${ORG}','security-c@example.test');`);
 expect('seven days, no unrelated extension, exact expiry, new ID on reissue',`${send}
 create temp table first_invite as select id,expires_at from public.org_invites where org_id='${ORG}' and status='pending'; grant select on first_invite to authenticated;
 ${send} select 'ttl:'||(extract(epoch from(expires_at-created_at))=604800) from public.org_invites where id=(select id from first_invite);
 select 'same:'||(i.id=f.id and i.expires_at=f.expires_at) from public.org_invites i,first_invite f where i.id=f.id;
 update public.org_invites set expires_at=clock_timestamp() where id=(select id from first_invite);
 ${jwt(C,`select 'expired:'||public.org_invite_respond((select id from first_invite),true);`)}
 select 'not-joined:'||(org_id is null) from public.profiles where id='${C}'; ${send}
 select 'new-id:'||(id<>(select id from first_invite)) from public.org_invites where status='pending' and org_id='${ORG}';
 ${jwt(C,`select 'old:'||public.org_invite_respond((select id from first_invite),true); select 'accepted:'||public.org_invite_respond((select id from public.org_invites where org_id='${ORG}' and status='pending'),true);`)}
 select 'joined:'||(org_id='${ORG}') from public.profiles where id='${C}';`,['ttl:true','same:true','expired:expired','not-joined:true','new-id:true','old:expired','accepted:ok','joined:true']);
 for(const sql of [`insert into public.org_invites(org_id,email,expires_at) values('${ORG}','x@example.test',now()+interval '1 year');`,`update public.org_invites set expires_at=now()+interval '1 year';`,`delete from public.org_invites;`]) deny('direct owner cannot mutate invitation lifecycle',`${send} ${jwt(B,sql)}`);
 expect('wrong recipient and enrolled sender refused',`${send} create temp table known_invite as select id from public.org_invites where org_id='${ORG}'; grant select on known_invite to authenticated; ${jwt(A,`select 'other:'||public.org_invite_respond((select id from known_invite),true);`)} insert into auth.mfa_factors(user_id,status) values('${B}','verified'); ${jwt(B,`select 'sender:'||public.org_invite_creator('${ORG}','security-a@example.test');`)}`,['other:not_invitee','sender:not_owner']);
 expect('expired pending and expired closed retention bounded',`${send} update public.org_invites set expires_at=now()-interval '100 days'; select public.run_retention_cleanup(365,90,365,90,90); select 'pending-left:'||count(*) from public.org_invites where org_id='${ORG}';`,['pending-left:0']);
 // Clone a catalog-only database for committed independent-session cases;
 // dropping that private database leaves no retained admin fixture elsewhere.
 const raceDb=`${db}_sec_${randomUUID().slice(0,8)}`;
 let made=false;
 try {
   const created=psql(db,['-c',`create database "${raceDb}" template "${db}";`],{allowFail:true});
   if(created.status!==0)throw Error(created.stderr);made=true;
   const sql=body=>psql(raceDb,['-c',body],{allowFail:true});
   const seeded=sql(seed);if(seeded.status!==0)throw Error(seeded.stderr);
   const updates=await Promise.all([ADM,ADM2].map(uid=>psqlAsync(raceDb,`begin;set local statement_timeout='5s'; update public.profiles set is_active=false where id='${uid}';commit;`)));
   checks++;
   if(updates.filter(r=>r.status===0).length!==1||updates.filter(r=>/last_active_admin/.test(r.stderr)).length!==1)bad.push(`two-admin mutation race: ${updates.map(r=>r.stderr).join(' | ')}`);
   const count=sql("select count(*) from public.profiles where role='admin' and is_active;");checks++;if(count.stdout.trim()!=='1')bad.push(`active admins after race: ${count.stdout}`);
   sql(`update public.profiles set is_active=true where id in('${ADM}','${ADM2}');`);
   const deletion=await Promise.all([
     psqlAsync(raceDb,`begin;set local statement_timeout='5s'; select public.creator_storage_account('begin','${ADM}',p_actor=>'${ADM}');commit;`),
     psqlAsync(raceDb,`begin;set local statement_timeout='5s'; update public.profiles set is_active=false where id='${ADM2}';commit;`),
   ]);
   checks++;if(deletion.some(r=>r.status!==0&&!/last_active_admin/.test(r.stderr)))bad.push(`deletion/security lock order: ${deletion.map(r=>r.stderr).join(' | ')}`);
   const after=sql("select count(*) from public.profiles where role='admin' and is_active;");checks++;if(after.stdout.trim()!=='1')bad.push(`active admins after delete race: ${after.stdout}`);
   // A stale admitted SQL statement must lose authority after waiting for a
   // newer admin demotion, even though its outer RLS snapshot began earlier.
   sql(`update public.profiles set role='admin',is_active=true where id in('${ADM}','${ADM2}','${C}');`);
   const revokedTag=`security-revoke-${randomUUID().slice(0,8)}`;
   const revoke=psqlAsync(raceDb,`begin;set local statement_timeout='20s';update public.profiles set role='creator' where id='${ADM}';set local application_name='${revokedTag}';${blocked(`${revokedTag}-stale`)}commit;`);
   const revokedReady=await psqlAsync(raceDb,`${seen(revokedTag)}select count(*) from pg_stat_activity where application_name='${revokedTag}';`);
   if(revokedReady.stdout.trim()!=='1'){await revoke;throw Error('admin revocation barrier not reached');}
   const stale=await psqlAsync(raceDb,`begin;set local statement_timeout='5s';set local application_name='${revokedTag}-stale';${jwt(ADM,`update public.profiles set is_active=false where id='${C}';`,'aal2')}commit;`);
   await revoke;checks++;
   const retained=sql(`select is_active from public.profiles where id='${C}';`);
   if((stale.status!==0&&!/admin authorization changed|permission denied/.test(stale.stderr))||retained.stdout.trim()!=='t')bad.push(`revoked admin regained profile authority: ${stale.stderr||stale.stdout}`);
   sql(`update public.profiles set role='creator' where id='${C}';`);
   const setup=sql(`${jwt(B,`select public.org_invite_creator('${ORG}','security-c@example.test');`)} update public.org_invites set expires_at=clock_timestamp()+interval '250 milliseconds' where org_id='${ORG}' and status='pending';`);
   if(setup.status!==0)throw Error(setup.stderr);
   const barrier=`security-expiry-${randomUUID().slice(0,8)}`;
   // The holder keeps the invitee's row until the response is seen waiting for
   // it AND the invitation's deadline has passed, so the deadline is crossed
   // during the wait whatever the machine load.
   const hold=psqlAsync(raceDb,`begin;set local statement_timeout='20s';select id from public.profiles where id='${C}' for update;set local application_name='${barrier}';${blocked(`${barrier}-response`)}do $$ begin for i in 1..1500 loop exit when clock_timestamp()>(select max(expires_at) from public.org_invites where org_id='${ORG}' and status='pending'); perform pg_sleep(0.01); end loop; end $$;commit;`);
   const ready=await psqlAsync(raceDb,`${seen(barrier)}select count(*) from pg_stat_activity where application_name='${barrier}';`);
   if(ready.stdout.trim()!=='1'){await hold;throw Error('expiry barrier not reached');}
   const response=await psqlAsync(raceDb,`begin;set local statement_timeout='5s';set local application_name='${barrier}-response';${jwt(C,`select 'late:'||public.org_invite_respond((select id from public.org_invites where org_id='${ORG}' and status='pending'),true);`)}commit;`);
   await hold;checks++;if(response.status!==0||!response.stdout.includes('late:expired'))bad.push(`deadline crossed while waiting: ${response.stderr||response.stdout}`);
   // A legitimate invitee can lose activity/approval/assurance while waiting
   // for its profile row. Both acceptance and decline must remain side-effect
   // free after that independently committed security change.
   for(const change of ['inactive','approval','mfa']) for(const accept of [true,false]) {
     const reset=sql(`update public.profiles set role='creator',is_active=true,approval_status='approved',org_id=null where id='${C}';delete from auth.mfa_factors where user_id='${C}';update public.org_invites set status='expired' where org_id='${ORG}' and status='pending';${jwt(B,`select public.org_invite_creator('${ORG}','security-c@example.test');`)}`);
     if(reset.status!==0)throw Error(reset.stderr);
     const pending=sql(`select id from public.org_invites where org_id='${ORG}' and email='security-c@example.test' and status='pending';`).stdout.trim();
     if(!/^[a-f0-9-]{36}$/.test(pending))throw Error('security-race pending invite missing');
     const tag=`invite-${change}-${accept}-${randomUUID().slice(0,8)}`;
     const mutation=change==='inactive'?`update public.profiles set is_active=false where id='${C}';`:change==='approval'?`update public.profiles set approval_status='rejected' where id='${C}';`:`insert into auth.mfa_factors(user_id,status) values('${C}','verified');`;
     const changed=psqlAsync(raceDb,`begin;set local statement_timeout='20s';select id from public.profiles where id='${C}' for update;${mutation}set local application_name='${tag}';${blocked(`${tag}-answer`)}commit;`);
     const waiting=await psqlAsync(raceDb,`${seen(tag)}select count(*) from pg_stat_activity where application_name='${tag}';`);
     if(waiting.stdout.trim()!=='1'){await changed;throw Error('invite security-change barrier not reached');}
     const answered=await psqlAsync(raceDb,`begin;set local statement_timeout='5s';set local application_name='${tag}-answer';${jwt(C,`select 'answer:'||public.org_invite_respond('${pending}',${accept});`)}commit;`);
     await changed;const state=sql(`select (org_id is null)||','||(select status from public.org_invites where id='${pending}') from public.profiles where id='${C}';`);checks++;
     if(answered.status!==0||!answered.stdout.includes('answer:inactive')||state.stdout.trim()!=='true,pending')bad.push(`invite ${change} while profile lock awaited (${accept?'accept':'decline'}): ${answered.stderr||answered.stdout.trim()} state=${state.stdout.trim()}`);
   }


   // Sender authority is checked again after all existing waits. A separate
   // profile lock-holder, sender request and security UPDATE avoid introducing
   // any profile -> active-admin lock inversion even in the fixture.
   const gateSetup=sql('create schema ff_invite_security_probe;create table ff_invite_security_probe.gate(id uuid primary key);');
   if(gateSetup.status!==0)throw Error(gateSetup.stderr);
   for(const change of ['inactive','approval','mfa']) {
     const reset=sql(`update public.profiles set role='creator',is_active=true,approval_status='approved',org_id=null where id in('${B}','${C}');delete from auth.mfa_factors where user_id in('${B}','${C}');update public.org_invites set status='expired' where org_id='${ORG}' and status='pending';`);
     if(reset.status!==0)throw Error(reset.stderr);
     const gate=randomUUID(),heldTag='invite-owner-held-'+randomUUID().slice(0,8),sendTag='invite-owner-send-'+randomUUID().slice(0,8);
     const holder=psqlAsync(raceDb,`begin;set local statement_timeout='20s';select id from public.profiles where id='${C}' for update;set local application_name='${heldTag}';do $$begin for i in 1..1500 loop exit when exists(select 1 from ff_invite_security_probe.gate where id='${gate}');perform pg_sleep(0.01);end loop;end$$;commit;`);
     const held=await psqlAsync(raceDb,`${seen(heldTag)}select count(*) from pg_stat_activity where application_name='${heldTag}';`);
     if(held.stdout.trim()!=='1'){sql(`insert into ff_invite_security_probe.gate(id)values('${gate}');`);await holder;throw Error('sender recipient-row barrier missing');}
     const sender=psqlAsync(raceDb,`begin;set local statement_timeout='5s';set local application_name='${sendTag}';${jwt(B,`select 'sent:'||public.org_invite_creator('${ORG}','security-c@example.test');`)}commit;`);
     const senderWaiting=await psqlAsync(raceDb,`${blocked(sendTag)}select count(*) from pg_stat_activity where application_name='${sendTag}' and wait_event_type='Lock';`);
     if(senderWaiting.stdout.trim()!=='1'){sql(`insert into ff_invite_security_probe.gate(id)values('${gate}');`);await Promise.all([holder,sender]);throw Error('sender was not waiting after owner admission');}
     const mutation=change==='inactive'?`update public.profiles set is_active=false where id='${B}';`:change==='approval'?`update public.profiles set approval_status='rejected' where id='${B}';`:`insert into auth.mfa_factors(user_id,status)values('${B}','verified');`;
     const revoke=sql(`begin;${mutation}insert into ff_invite_security_probe.gate(id)values('${gate}');commit;`);
     const [heldResult,sent]=await Promise.all([holder,sender]);const pending=sql(`select count(*) from public.org_invites where org_id='${ORG}' and status='pending';`);checks++;
     if(revoke.status!==0||heldResult.status!==0||sent.status!==0||!sent.stdout.includes('sent:not_owner')||pending.stdout.trim()!=='0')bad.push(`sender ${change} after admission: ${revoke.stderr||heldResult.stderr||sent.stderr||sent.stdout.trim()} pending=${pending.stdout.trim()}`);
   }
 }catch(error){bad.push(`concurrent probes: ${error.message}`);}
 finally{if(made)psql(db,['-c',`drop database "${raceDb}" with(force);`],{allowFail:true});}
 return {bad,checks};
}
