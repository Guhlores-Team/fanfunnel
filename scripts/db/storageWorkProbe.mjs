// @ts-check
//0058 durable-storage SQL contract. Runs ONLY on schema-drift's throwaway PG.
// Storage transport/order/crash behavior is covered by lib/storage/work.test.ts.
const uid = (tail) => `00000000-0000-4000-8000-0000000058${tail}`;
const A = uid('e1'), B = uid('e2'), C = uid('e3'), D = uid('e4');
const I = uid('f1'), J = uid('f2'), W = uid('f3'), MA = uid('a1'), MB = uid('a2');
const image = (owner, id) => `${owner}/${id}.webp`;
const seed = `
 grant usage on schema public, auth to anon, authenticated, service_role;
 insert into auth.users(id,email) values ('${A}','storage-a@example.test'),('${B}','storage-b@example.test'),('${C}','storage-c@example.test'),('${D}','storage-d@example.test');
 update public.profiles set role='creator';
 update public.profiles set is_active=true,approval_status='approved' where id in ('${A}','${B}','${C}','${D}');
 update public.profiles set role='admin' where id in ('${C}','${D}');
 insert into public.wheels(id,creator_id) values ('${uid('c1')}','${A}'),('${uid('c2')}','${B}');
 insert into public.fans(id,creator_id) values ('${uid('d1')}','${A}'),('${uid('d2')}','${B}');
 insert into public.fan_passes(token,creator_id,wheel_id,fan_id) values
 ('storage-probe-own-token','${A}','${uid('c1')}','${uid('d1')}'),('storage-probe-other-token','${B}','${uid('c2')}','${uid('d2')}');
 insert into public.creator_media(id,creator_id,path,width,height,sfw_attested_at) values
 ('${MA}','${A}','${image(A,MA)}',1,1,now()),('${MB}','${B}','${image(B,MB)}',1,1,now());`;
const as = (owner, body, aal = 'aal1') => `set local role authenticated; select set_config('request.jwt.claim.sub','${owner}',true); select set_config('request.jwt.claims','{"aal":"${aal}"}',true); ${body} reset role;`;
const account = (op, owner, extra='') => `select public.creator_storage_account('${op}','${owner}',p_worker=>'${W}'${extra});`;
/** @param {string} db @param {(db:string,args:string[],opts?:{allowFail?:boolean})=>import('node:child_process').SpawnSyncReturns<string>} psql */
export function probeStorageWork(db, psql) {
  const bad = [];
  const run = body => psql(db,['-c',`begin; ${seed} ${body} rollback;`],{allowFail:true});
  const requireLines = (label, body, lines) => {
    const result=run(body), output=(result.stdout||'').split('\n').map(line=>line.trim());
    if(result.status!==0 || lines.some(line=>!output.includes(line))) bad.push(`${label}: expected ${lines.join(' | ')}; ${(result.stderr||'').split('\n').find(line=>line.includes('ERROR'))||'output mismatch'}`);
  };
  const reject = (label, body, pattern) => {
    const result=run(body);
    if(result.status===0 || !pattern.test(result.stderr||'')) bad.push(`${label}: unexpectedly allowed or wrong refusal`);
  };
  const functions=['creator_storage_register_upload','creator_storage_finish_upload','creator_storage_queue_remove','creator_storage_complete_remove','creator_storage_account','creator_storage_prune','creator_storage_manifest','creator_storage_dispatch','creator_storage_publish_media','creator_storage_work_claim','creator_storage_security_write'];
  requireLines('service-only grants and RLS',`
    select 'exposed:'||count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in (${functions.map(name=>`'${name}'`).join(',')}) and (has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE'));
    select public.creator_storage_register_upload('${I}','${A}','avatars','${image(A,I)}');
    select public.creator_storage_register_upload('${J}','${B}','avatars','${image(B,J)}');
    ${as(A,`select 'own:'||count(*) from public.creator_storage_objects where owner_id='${A}'; select 'other:'||count(*) from public.creator_storage_objects where owner_id='${B}';`)}
    select 'object-write:'||has_table_privilege('authenticated','public.creator_storage_objects','INSERT');
    select 'job-write:'||has_table_privilege('authenticated','public.creator_storage_deletions','UPDATE');`,['exposed:0','own:1','other:0','object-write:false','job-write:false']);
  reject('cross-owner upload path',`select public.creator_storage_register_upload('${I}','${A}','avatars','${image(B,I)}');`,/creator_storage_object_scope/);
  reject('metadata cannot approve a pending creator',`update auth.users set raw_user_meta_data='{"role":"admin","approval_status":"approved","is_active":true}' where id='${A}'; update public.profiles set approval_status='pending' where id='${A}'; select public.creator_storage_register_upload('${I}','${A}','avatars','${image(A,I)}');`,/creator upload forbidden/);
  requireLines('pending theme setter',`update public.profiles set approval_status='pending' where id='${A}'; ${as(A,`select 'theme:'||coalesce(public.set_creator_theme('{"font":"syne"}')::text,'null');`)}`,['theme:null']);
  reject('new media cannot commit after quiescence',`${account('begin',A,`,p_actor=>'${A}'`)} insert into public.creator_media(creator_id,path,width,height,sfw_attested_at) values ('${A}','${image(A,I)}',1,1,now());`,/creator media forbidden/);
  reject('client cannot discard a storage retry path',as(A,`delete from public.creator_media where id='${MA}';`),/permission denied/);
  reject('client cannot finish someone else work',as(A,`select public.creator_storage_complete_remove('${I}');`),/permission denied/);
  requireLines('durable begin and unresolved upload',`
    select public.creator_storage_register_upload('${I}','${A}','avatars','${image(A,I)}');
    ${account('begin',A,`,p_actor=>'${A}'`)} ${account('claim',A)}
    select 'active:'||is_active from public.profiles where id='${A}';
    select 'pending:'||(public.creator_storage_account('prepare','${A}',p_worker=>'${W}')->>'state');
    select 'auth:'||count(*) from auth.users where id='${A}';
    select 'plaintext:'||position('storage-probe-own-token' in link_hashes::text) from public.creator_storage_deletions where owner_id='${A}';`,['active:false','pending:pending','auth:1','plaintext:0']);
  requireLines('late upload, auth cascade and idempotent completion',`
    select public.creator_storage_register_upload('${I}','${A}','avatars','${image(A,I)}');
    ${account('begin',A,`,p_actor=>'${A}'`)} ${account('claim',A)}
    select 'late:'||public.creator_storage_finish_upload('${I}','stored');
    select public.creator_storage_complete_remove('${I}');
    ${account('prepare',A)} delete from auth.users where id='${A}';
    select 'kept:'||count(*) from public.creator_storage_objects where owner_id='${A}';
    ${account('auth_deleted',A)} ${account('complete',A)} ${account('complete',A)}
    select 'state:'||state from public.creator_storage_deletions where owner_id='${A}';
    select 'audit:'||count(*) from public.admin_audit_log where target_id='${A}' and action='account.self_close';
    select 'hash:'||count(*) from public.link_tombstones where token_hash=encode(sha256(convert_to('storage-probe-own-token','UTF8')),'hex');
    select 'other-token:'||count(*) from public.link_tombstones where token_hash=encode(sha256(convert_to('storage-probe-other-token','UTF8')),'hex');`,['late:false','kept:1','state:complete','audit:1','hash:1','other-token:0']);
  requireLines('atomic last-admin guard and restoration',`
    ${account('begin',D,`,p_actor=>'${D}'`)} ${account('claim',D)}
    select 'reserved:'||role||':'||is_active from public.profiles where id='${D}';
    select 'last:'||(public.creator_storage_account('begin','${C}',p_actor=>'${C}')->>'error');
    ${account('pause',D,`,p_error=>'delete_failed'`)}
    select 'restored:'||role||':'||is_active from public.profiles where id='${D}';
    ${account('begin',A,`,p_was_admin=>true,p_actor=>'${A}'`)} ${account('claim',A)} ${account('pause',A,`,p_error=>'db_error'`)}
    select 'hint:'||role from public.profiles where id='${A}';`,['reserved:creator:false','last:last_admin','restored:admin:true','hint:creator']);
  reject('non-hashes cannot enter deletion work',`${account('begin',A,`,p_actor=>'${A}'`)} update public.creator_storage_deletions set link_hashes='["plaintext-token"]' where owner_id='${A}';`,/check constraint/);
  reject('ordinary creator cannot assert moderation admin',`select public.creator_storage_queue_remove('${B}','[{"id":"${MB}","path":"${image(B,MB)}"}]','${A}',true);`,/admin required/);
  requireLines('queued moderation and atomic audit',`
    select public.creator_storage_queue_remove('${B}','[{"id":"${MB}","path":"${image(B,MB)}"}]','${C}',true);
    select public.creator_storage_complete_remove(id) from public.creator_storage_objects where path='${image(B,MB)}';
    select public.creator_storage_complete_remove(id) from public.creator_storage_objects where path='${image(B,MB)}';
    select 'removed:'||count(*) from public.creator_media where id='${MB}';
    select 'untouched:'||count(*) from public.creator_media where id='${MA}';
    select 'audit:'||count(*) from public.admin_audit_log where target_id='${B}' and action='account.media_remove';`,['removed:0','untouched:1','audit:1']);
  requireLines('uncertain work never expires',`
    select public.creator_storage_register_upload('${I}','${A}','avatars','${image(A,I)}');
    select public.creator_storage_finish_upload('${I}','uncertain');
    update public.creator_storage_objects set created_at=now()-interval '60 days',expires_at=now()-interval '59 days' where id='${I}';
    select public.creator_storage_prune(1);
    select 'retained:'||count(*) from public.creator_storage_objects where id='${I}';`,['retained:1']);
  requireLines('expired list and attempt fencing',`
    ${account('begin',A,`,p_actor=>'${A}'`)} ${account('claim',A)}
    create temporary table storage_old_attempt as select attempt_id from public.creator_storage_deletions where owner_id='${A}';
    update public.creator_storage_deletions set lease_until=now()-interval '1 second' where owner_id='${A}';
    select public.creator_storage_account('claim','${A}',p_worker=>'${J}');
    select public.creator_storage_account('pause','${A}',p_worker=>'${J}',p_error=>'storage_cleanup_failed');
    select public.creator_storage_register_upload('${I}','${A}','avatars','${image(A,I)}');
    ${account('begin',A,`,p_actor=>'${A}'`)}
    select 'stale:'||coalesce(public.creator_storage_manifest('${A}',(select attempt_id from storage_old_attempt),'${W}','avatars','["${A}/legacy.png"]')::text,'null');
    select 'old-paths:'||count(*) from public.creator_storage_objects where path='${A}/legacy.png';
  `,['stale:null','old-paths:0']);
  requireLines('dispatch blocks unsafe restoration',`
    select public.creator_storage_register_upload('${I}','${A}','avatars','${image(A,I)}');
    select public.creator_storage_finish_upload('${I}','stored');
    ${account('begin',A,`,p_actor=>'${A}'`)} ${account('claim',A)}
    select public.creator_storage_dispatch('begin','${J}','${A}',p_kind=>'remove',p_attempt=>(select attempt_id from public.creator_storage_deletions where owner_id='${A}'),p_worker=>'${W}',p_object=>'${I}');
    update public.creator_storage_deletions set lease_until=now()-interval '1 second' where owner_id='${A}';
    select public.creator_storage_account('claim','${A}',p_worker=>'${MA}');
    select 'pause-pending:'||coalesce(public.creator_storage_account('pause','${A}',p_worker=>'${MA}')::text,'null');
    select 'inactive:'||(not is_active) from public.profiles where id='${A}';
    select public.creator_storage_dispatch('finish','${J}','${A}',p_outcome=>'acknowledged');
    select public.creator_storage_account('pause','${A}',p_worker=>'${MA}');
    select 'restored:'||is_active from public.profiles where id='${A}';
  `,['pause-pending:null','inactive:true','restored:true']);
  requireLines('unknown Auth dispatch never permits restoration',`
    ${account('begin',A,`,p_actor=>'${A}'`)} ${account('claim',A)} ${account('prepare',A)}
    select public.creator_storage_dispatch('begin','${J}','${A}',p_kind=>'auth',p_attempt=>(select attempt_id from public.creator_storage_deletions where owner_id='${A}'),p_worker=>'${W}');
    update public.creator_storage_deletions set lease_until=now()-interval '1 second' where owner_id='${A}';
    select public.creator_storage_account('claim','${A}',p_worker=>'${MA}');
    select public.creator_storage_dispatch('finish','${J}','${A}',p_outcome=>'uncertain');
    select 'auth-pause:'||coalesce(public.creator_storage_account('pause','${A}',p_worker=>'${MA}')::text,'null');
    select 'auth-inactive:'||(not is_active) from public.profiles where id='${A}';
  `,['auth-pause:null','auth-inactive:true']);
  requireLines('atomic media binding and rollback',`
    select public.creator_storage_register_upload('${I}','${A}','creator-media','${image(A,I)}');
    select public.creator_storage_finish_upload('${I}','stored');
    do $body$ begin perform public.creator_storage_publish_media('${I}','invalid',2000,1); exception when check_violation then null; end $body$;
    select 'rolled-back:'||count(*) from public.creator_media where id='${I}';
    select public.creator_storage_publish_media('${I}','safe',1,1);
    select public.creator_storage_publish_media('${I}','safe',1,1);
    select 'bound:'||(media_id=id and published_at is not null) from public.creator_storage_objects where id='${I}';
    select 'one-media:'||count(*) from public.creator_media where id='${I}';
    select public.creator_storage_finish_upload('${I}','cleanup');
    select public.creator_storage_complete_remove('${I}');
    select 'no-dangling:'||count(*) from public.creator_media where id='${I}';
  `,['rolled-back:0','bound:true','one-media:1','no-dangling:0']);
  requireLines('fair pending rotation',`
    insert into public.creator_storage_objects(owner_id,bucket,path,upload_state,cleanup_kind,next_attempt_at)
      select '${A}','avatars','${A}/'||gen_random_uuid()::text||'.webp','uncertain','orphan',now()-interval '1 hour' from generate_series(1,25);
    insert into public.creator_storage_objects(id,owner_id,bucket,path,upload_state,cleanup_kind,next_attempt_at)
      values('${I}','${A}','avatars','${image(A,I)}','stored','orphan',now());
    select count(*) from jsonb_array_elements(public.creator_storage_work_claim(20));
    select 'new-reached:'||count(*) from jsonb_array_elements(public.creator_storage_work_claim(20)) where value->>'id'='${I}';
    select 'uncertain-preserved:'||count(*) from public.creator_storage_objects where upload_state='uncertain' and removed_at is null and last_attempt_at is not null and next_attempt_at>now();
  `,['new-reached:1','uncertain-preserved:25']);
  requireLines('same-value admin suspension fences restoration',`
    grant select,update on public.profiles to authenticated;
    ${account('begin',A,`,p_actor=>'${A}'`)} ${account('claim',A)}
    ${as(C,`update public.profiles set is_active=false where id='${A}';`,'aal2')}
    select 'restore-fenced:'||(not restore_allowed) from public.creator_storage_deletions where owner_id='${A}';
    ${account('pause',A)}
    select 'still-suspended:'||(not is_active) from public.profiles where id='${A}';
  `,['restore-fenced:true','still-suspended:true']);
  requireLines('admin demotion and approval intent survive pause',`
    grant select,update on public.profiles to authenticated;
    ${account('begin',D,`,p_actor=>'${D}'`)} ${account('claim',D)}
    ${as(C,`update public.profiles set role='creator',is_active=false where id='${D}';`,'aal2')}
    ${account('pause',D)}
    select 'demotion-kept:'||role||':'||is_active from public.profiles where id='${D}';
    ${account('begin',A,`,p_actor=>'${A}'`)} ${account('claim',A)}
    ${as(C,`update public.profiles set approval_status='rejected' where id='${A}';`,'aal2')}
    ${account('pause',A)}
    select 'approval-kept:'||approval_status||':'||is_active from public.profiles where id='${A}';
  `,['demotion-kept:creator:false','approval-kept:rejected:false']);
  requireLines('unrelated profile edit permits ordinary restoration',`
    grant select,update on public.profiles to authenticated;
    ${account('begin',A,`,p_actor=>'${A}'`)} ${account('claim',A)}
    ${as(C,`update public.profiles set display_name='new name' where id='${A}';`,'aal2')}
    select 'restore-allowed:'||restore_allowed from public.creator_storage_deletions where owner_id='${A}';
    ${account('pause',A)} select 'restored-active:'||is_active from public.profiles where id='${A}';
  `,['restore-allowed:true','restored-active:true']);
  requireLines('creator cannot invalidate another owner fence or forge security authority',`
    grant select,update on public.profiles to authenticated;
    ${account('begin',A,`,p_actor=>'${A}'`)} ${account('claim',A)}
    ${as(B,`update public.profiles set is_active=false where id in ('${A}','${B}');`)}
    select 'unforged:'||restore_allowed from public.creator_storage_deletions where owner_id='${A}';
    select set_config('app.restore_allowed','true',true);
    ${as(C,`update public.profiles set is_active=false where id='${A}';`,'aal2')}
    update auth.users set raw_user_meta_data='{"restore_allowed":true,"role":"admin"}' where id='${A}';
    ${account('pause',A)} select 'metadata-no-restore:'||(not is_active) from public.profiles where id='${A}';
  `,['unforged:true','metadata-no-restore:true']);
  reject('creator cannot re-arm a restoration fence',`${account('begin',A,`,p_actor=>'${A}'`)} ${as(B,`update public.creator_storage_deletions set restore_allowed=true where owner_id='${A}';`)}`,/permission denied/);
  reject('anon cannot re-arm a restoration fence',`${account('begin',A,`,p_actor=>'${A}'`)} set local role anon; update public.creator_storage_deletions set restore_allowed=true where owner_id='${A}';`,/permission denied/);
  for(const state of ['pending','auth_deleting','auth_deleted']) {
    reject(`admin cannot reactivate ${state} deletion`,`${account('begin',A,`,p_actor=>'${A}'`)} update public.creator_storage_deletions set state='${state}' where owner_id='${A}'; grant select,update on public.profiles to authenticated; ${as(C,`update public.profiles set is_active=true where id='${A}';`,'aal2')}`,/account cleanup pending/);
  }
  requireLines('dispatch table RLS',`
    insert into public.creator_storage_dispatches(id,owner_id,attempt_id,kind) values('${I}','${B}','${W}','auth');
    ${as(A,`select 'foreign-dispatch:'||count(*) from public.creator_storage_dispatches where owner_id='${B}';`)}
    select 'dispatch-write:'||has_table_privilege('authenticated','public.creator_storage_dispatches','INSERT');
  `,['foreign-dispatch:0','dispatch-write:false']);
  return bad;
}

/** Real independent sessions prove both profile-lock orderings, without timers
 * deciding which security intent wins. @param {string} db @param {Function} psql @param {Function} psqlAsync */
export async function probeStorageSecurityRaces(db, psql, psqlAsync) {
  const bad=[];
  for(const target of [A,D]) for(const adminFirst of [true,false]) {
    const label=`${target===A?'suspension':'demotion'} ${adminFirst?'admin-before-pause':'pause-before-admin'}`;
    const setup=psql(db,['-c',`begin; grant select,update on public.profiles to authenticated; ${seed.replace(" update public.profiles set role='creator';",'')} ${account('begin',target,`,p_actor=>'${target}'`)} ${account('claim',target)} commit;`],{allowFail:true});
    if(setup.status!==0){bad.push(`${label}: fixture failed`);continue;}
    const admin=as(C,`update public.profiles set ${target===D?"role='creator',":''}is_active=false where id='${target}';`,'aal2');
    const pause=account('pause',target);
    const tag=`ff-storage-${target.slice(-2)}-${adminFirst?'admin':'pause'}`;
    let first;
    try {
      first=psqlAsync(db,`begin; set local statement_timeout='5s'; set local application_name='${tag}'; ${adminFirst?admin:pause} select pg_sleep(0.35); commit;`);
      let locked=false;
      for(let i=0;i<100;i++) {
        const ready=await psqlAsync(db,`select count(*) from pg_stat_activity where application_name='${tag}' and wait_event='PgSleep';`);
        if(ready.stdout.trim()==='1'){locked=true;break;}
        await psqlAsync(db,'select pg_sleep(0.01);');
      }
      if(!locked){bad.push(`${label}: first transaction never reached its held-row barrier`);await first;continue;}
      const second=psqlAsync(db,`begin; set local statement_timeout='5s'; ${adminFirst?pause:admin} commit;`);
      const results=await Promise.all([first,second]);
      if(results.some(result=>result.status!==0)){bad.push(`${label}: concurrent transaction failed ${results.map(r=>r.stderr).join(' ')}`);continue;}
      const state=psql(db,['-c',`select role||':'||is_active from public.profiles where id='${target}'; select state from public.creator_storage_deletions where owner_id='${target}';`],{allowFail:true});
      if(state.status!==0||!state.stdout.split('\n').includes('creator:false')||!state.stdout.split('\n').includes('paused')) bad.push(`${label}: later admin security intent lost (${state.stdout.trim()})`);
    } finally {
      if(first)await first;
      psql(db,['-c',`delete from public.creator_storage_dispatches where owner_id in ('${A}','${B}','${C}','${D}'); delete from public.creator_storage_objects where owner_id in ('${A}','${B}','${C}','${D}'); delete from public.creator_storage_deletions where owner_id in ('${A}','${B}','${C}','${D}'); delete from auth.users where id in ('${A}','${B}','${C}','${D}');`],{allowFail:true});
    }
  }
  return bad;
}
