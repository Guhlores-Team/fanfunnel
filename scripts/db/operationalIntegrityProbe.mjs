// @ts-check
//0063 ONLY on a disposable local database. Every normal fixture rolls back;
//race fixtures use a disposable clone. No real reward payload is returned.
import { randomUUID } from 'node:crypto';
import { mintActorContext } from './actorContextFixture.mjs';
const q = value => `'${String(value).replaceAll("'", "''")}'`;
const uid = tail => `00000000-0000-4000-8000-0000000063${tail}`;
const C=uid('c1'), A=uid('a1'), B=uid('a2'), F=uid('f1'), P=uid('f2'), W=uid('b1'), Z=uid('b2'), K=uid('b3'), R=uid('b4'), H=uid('b5'), PACK=uid('b6');
const jwt = (id,body,aal='aal1') => `set local role authenticated;select set_config('request.jwt.claim.sub','${id}',true);select set_config('request.jwt.claims','{"aal":"${aal}"}',true);${body}reset role;`;
// These fixture settings store only capabilities minted by the authenticated RPC;
// arbitrary settings never substitute for a real stored actor/session context.
const mint = (actor, scope, setting, aal='aal2') => `set local role authenticated;do $$begin
 perform set_config('request.jwt.claim.sub','${actor}',true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub','${actor}','role','authenticated','aal','${aal}','session_id','${actor}','exp',extract(epoch from clock_timestamp()+interval '1 hour')::bigint)::text,true);
 perform set_config('${setting}',public.issue_creator_actor_context('${actor}','${scope}')::text,true);
 end$$;reset role;`;
const creatorContext = "current_setting('fixture.ops_creator_context')::uuid";
const adminContext = "current_setting('fixture.ops_admin_context')::uuid";
const seed = `grant usage on schema public,auth to anon,authenticated,service_role;
 insert into auth.users(id,email) values('${C}','integrity-creator@example.test'),('${A}','integrity-admin@example.test'),('${B}','integrity-admin2@example.test');
 update public.profiles set role='creator',is_active=true,approval_status='approved' where id in('${C}','${A}','${B}');
 update public.profiles set role='admin' where id in('${A}','${B}');
 insert into auth.sessions(id,user_id) values('${A}','${A}'),('${C}','${C}');
 insert into auth.mfa_factors(user_id,status) values('${A}','verified');
 insert into public.wheels(id,creator_id) values('${W}','${C}');
 insert into public.prizes(id,wheel_id,label,stock,boostable) values('${Z}','${W}','Integrity probe',10,true);
 insert into public.fans(id,creator_id) values('${F}','${C}');
 insert into public.fan_passes(id,token,creator_id,wheel_id,fan_id) values('${P}','integrity-disposable-token','${C}','${W}','${F}');
 insert into public.focus_creator_config(creator_id,chase_enabled) values('${C}',true);
 insert into public.campaign_packs(id,creator_id,label,spins,pack_kind,chase_within) values('${PACK}','${C}','Integrity chase',5,'chase',5);`;
const canary = `'{"cipher":"${'a'.repeat(32)}","iv":"${'b'.repeat(16)}","keyVersion":1,"fingerprint":"${'c'.repeat(64)}"}'::jsonb`;
const emptyDigest=`encode(digest('','sha256'),'hex')`;
const init = (actor='null',digest=emptyDigest,context=actor==='null'?'null':adminContext) => `public.initialize_reward_crypto_canary(${canary},${digest},${actor},${context})`;
const diag = `public.run_reward_ledger_invariants()`;
const focus = `insert into public.fan_focus(id,creator_id,fan_id,fan_pass_id,wheel_id,prize_id,prize_label,kind,multiplier,total_spins,spins_left) values('${H}','${C}','${F}','${P}','${W}','${Z}','Integrity probe','chase',3,5,5);`;
const reservation = `insert into public.chase_reservations(id,focus_id,creator_id,prize_id,kind) values('${R}','${H}','${C}','${Z}','stock');`;
const grant = `public.grant_focus_pack(${creatorContext},'${uid('d1')}','${C}','${F}','${P}','${PACK}','${Z}','${C}')`;
/** @param {string} db @param {Function} psql @param {Function} [psqlAsync] */
export async function probeOperationalIntegrity(db, psql, psqlAsync) {
 const bad=[]; let checks=0;
 const run=body=>psql(db,['-c',`begin;${seed}${mint(A,'system_health','fixture.ops_admin_context')}${mint(C,'grant','fixture.ops_creator_context','aal1')}${body}rollback;`],{allowFail:true});
 const expect=(label,body,lines)=>{checks++;const r=run(body),out=r.stdout.split('\n').map(s=>s.trim());if(r.status!==0||lines.some(s=>!out.includes(s)))bad.push(`${label}: ${(r.stderr||'').split('\n').find(s=>s.includes('ERROR'))||'redacted assertion mismatch'}`);};
 const reject=(label,body,pattern=/permission denied/)=>{checks++;const r=run(body);if(r.status===0||!pattern.test(r.stderr))bad.push(`${label}: missing expected denial`);};
 const functions=['protect_reward_crypto_canary','record_chase_stock_evidence','witness_chase_stock_debit','fence_reward_inventory_write','_reward_crypto_inventory','read_reward_crypto_canary','reward_crypto_inventory_page','initialize_reward_crypto_canary','run_reward_ledger_invariants','record_system_health_check'];
 expect('service-only function grants',`select 'exposed:'||count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in(${functions.map(q).join(',')}) and(has_function_privilege('anon',p.oid,'EXECUTE')or has_function_privilege('authenticated',p.oid,'EXECUTE'));`,['exposed:0']);
 for(const role of ['anon','authenticated'])for(const table of ['reward_crypto_canary','chase_stock_evidence'])reject(`${role} cannot read private ${table}`,`set local role ${role};select count(*) from public.${table};`);
 for(const table of ['reward_crypto_canary','system_health_checks','chase_stock_evidence'])expect(`${table} has RLS and clients cannot write`,`select 'rls:'||relrowsecurity from pg_class where oid='public.${table}'::regclass;select 'write:'||(has_table_privilege('authenticated','public.${table}','INSERT')or has_table_privilege('authenticated','public.${table}','UPDATE')or has_table_privilege('authenticated','public.${table}','DELETE'));`,['rls:true','write:false']);
 expect('admin health row uses actual profile role and aal2',`select public.record_system_health_check('manual','healthy',${diag});${jwt(C,"select 'creator:'||count(*) from public.system_health_checks;")}${jwt(A,"select 'aal1:'||count(*) from public.system_health_checks;")}${jwt(A,"select 'aal2:'||count(*) from public.system_health_checks;",'aal2')}update auth.users set raw_user_meta_data='{"role":"admin"}' where id='${C}';${jwt(C,"select 'metadata:'||count(*) from public.system_health_checks;",'aal2')}`,['creator:0','aal1:0','aal2:1','metadata:0']);
 reject('anon cannot read health',`set local role anon;select * from public.system_health_checks;`);
 for(const role of ['anon','authenticated'])for(const call of ['read_reward_crypto_canary()','reward_crypto_inventory_page()',`initialize_reward_crypto_canary(${canary},${emptyDigest},null)`,'run_reward_ledger_invariants()',"record_system_health_check('manual','healthy')"])reject(`${role} cannot call service RPC`, `set local role ${role};select public.${call};`);
 expect('empty bootstrap and idempotency',`select 'first:'||(${init()}->>'status');select 'second:'||(${init()}->>'status');select 'anchors:'||count(*) from public.reward_crypto_canary;`,['first:initialized','second:existing','anchors:1']);
 reject('anchor immutable update',`select ${init()};update public.reward_crypto_canary set fingerprint=repeat('d',64);`,/anchor is immutable/);
 reject('anchor immutable delete',`select ${init()};delete from public.reward_crypto_canary;`,/anchor is immutable/);
 reject('service cannot bypass guarded initialization',`set local role service_role;insert into public.reward_crypto_canary(cipher,iv,key_version,fingerprint) values(repeat('a',32),repeat('b',16),1,repeat('c',64));`);
 expect('creator cannot impersonate admin initializer',`select 'init:'||(${init(q(C))}->>'status');`,['init:forbidden']);
 expect('explicit admin initialization without context is refused',`select 'init:'||(${init(q(A),emptyDigest,'null')}->>'status');`,['init:forbidden']);
 expect('guessed context cannot initialize',`select 'init:'||(${init(q(A),emptyDigest,q(uid('99')))}->>'status');`,['init:forbidden']);
 expect('wrong-scope capability cannot initialize',`${mint(A,'grant','fixture.ops_wrong_context')}select 'init:'||(${init(q(A),emptyDigest,"current_setting('fixture.ops_wrong_context')::uuid")}->>'status');`,['init:forbidden']);
 expect('foreign actor cannot consume admin context',`select 'init:'||(${init(q(B))}->>'status');`,['init:forbidden']);
 expect('session deletion invalidates initializer context',`delete from auth.sessions where id='${A}';select 'init:'||(${init(q(A))}->>'status');`,['init:forbidden']);
 expect('current demotion invalidates initializer context',`update public.profiles set role='creator' where id='${A}';select 'init:'||(${init(q(A))}->>'status');`,['init:forbidden']);
 expect('legacy service initialization overload is retired',`select 'legacy:'||count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='initialize_reward_crypto_canary' and p.pronargs=3 and has_function_privilege('service_role',p.oid,'EXECUTE');`,['legacy:0']);
 const reward=`insert into public.prize_rewards(prize_id,creator_id,kind,cipher,iv,key_version) values('${Z}','${C}','text',repeat('a',32),repeat('b',16),1);`;
 const digest=`(select encode(digest(coalesce(string_agg(row_digest,'' order by cursor collate "C"),''),'sha256'),'hex') from public._reward_crypto_inventory())`;
 expect('startup cannot bless existing inventory',`${reward}select 'init:'||(${init()}->>'status');select 'anchors:'||count(*) from public.reward_crypto_canary;`,['init:initialization_required','anchors:0']);
 expect('inventory digest CAS',`${reward}select 'changed:'||(${init(q(A))}->>'status');select 'verified:'||(${init(q(A),digest)}->>'status');`,['changed:inventory_changed','verified:initialized']);
 expect('private inventory pages bounded',`${reward}select 'rows:'||jsonb_array_length(public.reward_crypto_inventory_page('',999999)->'rows');`,['rows:1']);
 const code=`insert into public.prize_reward_codes(id,prize_id,creator_id,cipher,iv,key_version,fingerprint) values('${K}','${Z}','${C}',repeat('a',32),repeat('b',16),1,repeat('d',64));`;
 expect('legacy erased codes cannot bless fingerprint key',`${code}update public.prize_reward_codes set cipher=null,iv=null,hint=null,erased_at=now(),spin_id='${uid('e1')}',assigned_at=now() where id='${K}';select 'init:'||(${init(q(A),digest)}->>'status');`,['init:recovery_required']);
 expect('healthy empty ledger',`select 'state:'||(${diag}->>'status');`,['state:healthy']);
 expect('row budget incomplete',`insert into public.prizes(wheel_id,label) values('${W}','Budget fixture');select 'state:'||(public.run_reward_ledger_invariants(1)->>'status');`,['state:incomplete']);
 expect('actual atomic chase grant is witnessed',`select 'grant:'||(${grant}->>'status');select 'witness:'||units_taken from public.chase_stock_evidence;select 'stock:'||stock from public.prizes where id='${Z}';select 'state:'||(${diag}->>'status');`,['grant:granted','witness:1','stock:9','state:healthy']);
 expect('promised reservation alone is not a stock witness',`${focus}${reservation}select 'missing:'||(${diag}->'counts'->>'unwitnessedStockReservation');`,['missing:1']);
 expect('reservation then actual debit is healthy',`${focus}${reservation}update public.prizes set stock=stock-1 where id='${Z}';select 'state:'||(${diag}->>'status');`,['state:healthy']);
 expect('debit before reservation is not falsely witnessed',`update public.prizes set stock=stock-1 where id='${Z}';${focus}${reservation}select 'missing:'||(${diag}->'counts'->>'unwitnessedStockReservation');`,['missing:1']);
 expect('release preserves economic release and excludes terminal reservation',`select ${grant};select public.cancel_fan_focus(${creatorContext},'${C}','${F}',(select id from public.fan_focus where fan_id='${F}'),'${C}');select 'stock:'||stock from public.prizes where id='${Z}';select 'state:'||(${diag}->>'status');`,['stock:10','state:healthy']);
 expect('consumption leaves terminal witness honest',`${focus}${reservation}update public.prizes set stock=stock-1 where id='${Z}';update public.chase_reservations set state='consumed' where id='${R}';update public.fan_focus set status='done' where id='${H}';select 'state:'||(${diag}->>'status');`,['state:healthy']);
 expect('reservation deletion cascades witness',`${focus}${reservation}update public.prizes set stock=stock-1 where id='${Z}';delete from public.fan_focus where id='${H}';select 'witnesses:'||count(*) from public.chase_stock_evidence;`,['witnesses:0']);
 expect('missing live reservation detected',`${focus}select 'missing:'||(${diag}->'counts'->>'liveChaseMissingReservation');`,['missing:1']);
 expect('fan credit mismatch detected read-only',`set local fanfunnel.economic_write='on';alter table public.fans disable trigger user;update public.fans set spins_remaining=2 where id='${F}';alter table public.fans enable trigger user;select 'credit:'||(${diag}->'counts'->>'fanCreditMismatch');select 'unchanged:'||spins_remaining from public.fans where id='${F}';`,['credit:1','unchanged:2']);
 expect('code stock drift detected read-only',`alter table public.prizes disable trigger user;update public.prizes set delivery='codes',stock=4 where id='${Z}';alter table public.prizes enable trigger user;select 'drift:'||(${diag}->'counts'->>'codeStockMismatch');select 'unchanged:'||stock from public.prizes where id='${Z}';`,['drift:1','unchanged:4']);
 expect('legacy stock holds are explicitly unverified',`${focus}alter table public.chase_reservations disable trigger record_chase_stock_evidence;${reservation}alter table public.chase_reservations enable trigger record_chase_stock_evidence;select 'legacy:'||(${diag}->'counts'->>'unwitnessedStockReservation');`,['legacy:1']);
 expect('code hold must own an unused encrypted code',`${code}${focus}insert into public.chase_reservations(id,focus_id,creator_id,prize_id,kind,code_id) values('${R}','${H}','${C}','${Z}','code','${K}');select 'held:'||(${diag}->'counts'->>'heldCodeMismatch');`,['held:1']);
 expect('orphan reserved code detected',`${code}${focus}update public.prize_reward_codes set reserved_focus_id='${H}' where id='${K}';select 'orphan:'||(${diag}->'counts'->>'orphanReservedCode');`,['orphan:1']);
 expect('reservation scope mismatch detected',`${focus}${reservation}update public.fan_focus set status='done' where id='${H}';select 'scope:'||(${diag}->'counts'->>'heldReservationMismatch');`,['scope:1']);
 expect('one unit cannot witness two holds',`${focus}${reservation}insert into public.fans(id,creator_id) values('${uid('f3')}','${C}');insert into public.fan_focus(id,creator_id,fan_id,prize_id,prize_label,kind,multiplier,total_spins,spins_left) values('${uid('f4')}','${C}','${uid('f3')}','${Z}','Second','chase',3,5,5);insert into public.chase_reservations(focus_id,creator_id,prize_id,kind)values('${uid('f4')}','${C}','${Z}','stock');update public.prizes set stock=stock-1 where id='${Z}';select 'witnessed:'||sum(units_taken) from public.chase_stock_evidence;select 'unbacked:'||(${diag}->'counts'->>'unwitnessedStockReservation');`,['witnessed:1','unbacked:1']);
 expect('failure latch survives startup success and manual check clears',`select public.record_system_health_check('startup','mismatch');select 'latched:'||((public.record_system_health_check('startup','healthy')->>'canaryFailureAt') is not null);select 'cleared:'||((public.record_system_health_check('manual','healthy',${diag})->>'canaryFailureAt') is null);select 'maintenance:'||((public.record_system_health_check('maintenance','healthy',${diag})->>'lastMaintenanceAt') is not null);`,['latched:true','cleared:true','maintenance:true']);
 reject('SQL cannot record incomplete false healthy',`select public.record_system_health_check('manual','healthy','{"status":"healthy","counts":{}}');`,/incomplete or inconsistent/);
 reject('SQL cannot record nonzero false healthy',`select public.record_system_health_check('manual','healthy',jsonb_set(${diag},'{counts,fanCreditMismatch}','1'));`,/incomplete or inconsistent/);
 reject('unknown diagnostic count rejected',`select public.record_system_health_check('manual','healthy','{"status":"healthy","counts":{"cipher":0}}');`,/invalid invariant result/);
 if(psqlAsync){
  const raceDb=`ops_race_${randomUUID().replaceAll('-','').slice(0,16)}`;let made=false;
  try{
   let r=psql(db,['-c',`create database "${raceDb}" template "${db}";`],{allowFail:true});if(r.status!==0)throw Error('clone failed');made=true;
   r=psql(raceDb,['-c',seed],{allowFail:true});if(r.status!==0)throw Error('race seed failed');
   const results=await Promise.all([psqlAsync(raceDb,`select 'init:'||(${init()}->>'status');`),psqlAsync(raceDb,`select 'init:'||(${init()}->>'status');`)]);
   checks++;if(results.some(r=>r.status!==0)||results.map(r=>r.stdout.trim()).sort().join('|')!=='init:existing|init:initialized')bad.push('concurrent first initialization did not serialize');
   checks++;r=psql(raceDb,['-c',`select count(*) from public.reward_crypto_canary;`],{allowFail:true});if(r.stdout.trim()!=='1')bad.push('first initialization created more than one anchor');
   // A stock debit in another transaction cannot witness an earlier promise.
   r=psql(raceDb,['-c',`${focus}${reservation}`],{allowFail:true});if(r.status!==0)throw Error('witness seed failed');
   r=psql(raceDb,['-c',`update public.prizes set stock=stock-1 where id='${Z}';select units_taken from public.chase_stock_evidence;`],{allowFail:true});checks++;if(r.status!==0||r.stdout.trim()!=='0')bad.push('cross-transaction debit incorrectly witnessed reservation');
   // An in-flight encrypted write changes the CAS snapshot. Initialization
   // waits on the advisory fence, then must use a fresh committed snapshot.
   psql(db,['-c',`drop database "${raceDb}" with(force);`],{allowFail:true});made=false;
   r=psql(db,['-c',`create database "${raceDb}" template "${db}";`],{allowFail:true});if(r.status!==0)throw Error('CAS clone failed');made=true;
   r=psql(raceDb,['-c',`${seed}${reward}`],{allowFail:true});if(r.status!==0)throw Error('CAS seed failed');
   const old=psql(raceDb,['-c',`select ${digest};`],{allowFail:true}).stdout.trim();
   const raceSql=async statement=>{const r=await psqlAsync(raceDb,statement);if(r.status!==0)throw Error('actor fixture mint failed');return r.stdout;};
   const {context:casContext}=await mintActorContext(raceSql,A,A,'system_health','aal2');
   const tag=`ops-write-${randomUUID().slice(0,8)}`;
   const writer=psqlAsync(raceDb,`begin;set local application_name='${tag}';update public.prize_rewards set cipher=repeat('z',32) where prize_id='${Z}';select pg_sleep(0.4);commit;`);
   let ready=false;
   for(let n=0;n<40;n++){const b=await psqlAsync(raceDb,`select count(*) from pg_stat_activity where application_name='${tag}' and wait_event='PgSleep';`);if(b.stdout.trim()==='1'){ready=true;break;}await psqlAsync(raceDb,'select pg_sleep(0.01)');}
   if(!ready)throw Error('CAS writer barrier failed');
   const cas=await psqlAsync(raceDb,`select 'cas:'||(${init(q(A),q(old),q(casContext))}->>'status');`);const write=await writer;
   checks++;if(write.status!==0||cas.status!==0||!cas.stdout.includes('cas:inventory_changed'))bad.push('inventory writer race did not refuse stale verified digest');
   r=psql(raceDb,['-c','select count(*) from public.reward_crypto_canary;'],{allowFail:true});checks++;if(r.stdout.trim()!=='0')bad.push('stale scan unexpectedly created anchor');
   // A request admitted before an admin demotion cannot initialize afterwards.
   const current=psql(raceDb,['-c',`select ${digest};`],{allowFail:true}).stdout.trim();
   const {context:revocationContext}=await mintActorContext(raceSql,A,A,'system_health','aal2');
   const revokeTag=`ops-revoke-${randomUUID().slice(0,8)}`;
   const revoke=psqlAsync(raceDb,`begin;set local application_name='${revokeTag}';update public.profiles set role='creator' where id='${A}';select pg_sleep(0.4);commit;`);
   ready=false;
   for(let n=0;n<40;n++){const b=await psqlAsync(raceDb,`select count(*) from pg_stat_activity where application_name='${revokeTag}' and wait_event='PgSleep';`);if(b.stdout.trim()==='1'){ready=true;break;}await psqlAsync(raceDb,'select pg_sleep(0.01)');}
   if(!ready)throw Error('admin revocation barrier failed');
   const staleAdmin=await psqlAsync(raceDb,`select 'admin:'||(${init(q(A),q(current),q(revocationContext))}->>'status');`);const revoked=await revoke;
   checks++;if(staleAdmin.status!==0||revoked.status!==0||!staleAdmin.stdout.includes('admin:forbidden'))bad.push('stale administrator initialized after revocation');

  }catch(error){bad.push(`race probe: ${error.message}`);}finally{if(made)psql(db,['-c',`drop database "${raceDb}" with(force);`],{allowFail:true});}
 }
 return {bad,checks};
}
