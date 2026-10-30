// Disposable PostgreSQL16 contract fixture. pg_cron/pg_net/Vault workers and
// Vault's C cipher are NOT installed here: published table/trigger contracts
// are reproduced, real pgcrypto encrypts disposable values, and HTTP is fake.
import {spawn,spawnSync} from 'node:child_process';
import {chownSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {CONFIGURATION_SQL,CONTRACT_SQL,SETUP_SQL,STATUS_SQL,CRON_COMMAND,INITIAL_DESCRIPTION,ROLLBACK_SQL,configurationSQL} from './test-maintenance-sql.mjs';
import {JOB_NAME,VAULT_NAME} from './test-maintenance-guards.mjs';
import {summarizeStatus} from './test-maintenance.mjs';
const bin=process.env.PG_BIN;if(!bin)throw Error('PG_BIN required');
// Postgres refuses to run as root; like scripts/db/schema-drift-check.mjs, drop the
// server processes to the `postgres` OS user in that case.
let runAs={};
if(typeof process.getuid==='function'&&process.getuid()===0){
 const uid=spawnSync('id',['-u','postgres'],{encoding:'utf8'}),gid=spawnSync('id',['-g','postgres'],{encoding:'utf8'});
 if(uid.status!==0||gid.status!==0)throw Error('running as root and no `postgres` OS user exists to start the server as');
 runAs={uid:Number(uid.stdout.trim()),gid:Number(gid.stdout.trim())};
}
const root=mkdtempSync(join(tmpdir(),'ff-test-maintenance-')),data=join(root,'data'),port='54284';
if(runAs.uid!==undefined)chownSync(root,runAs.uid,runAs.gid);
const quote=value=>`'${String(value).replaceAll("'","''")}'`;
const SECRET='disposable_fixture_value_never_real_0000000000000000000000000000';
let checks=0;const check=(label,value)=>{if(!value)throw Error(label);checks++;};
function pg(name,args){const p=spawnSync(join(bin,name),args,{encoding:'utf8',cwd:root,...runAs});if(p.status!==0)throw Error(`${name} failed`);return p;}
function sql(query,{allowFail=false}={}){const p=spawnSync(join(bin,'psql'),['-h',root,'-p',port,'-U','postgres','-d','postgres','-X','-qAt','-v','ON_ERROR_STOP=1','-c',query],{encoding:'utf8'});if(p.status!==0&&!allowFail)throw Error((p.stderr||'').split('\n').find(row=>row.includes('ERROR'))??'local SQL failed');return p;}
function asyncSQL(query){return new Promise(resolve=>{const p=spawn(join(bin,'psql'),['-h',root,'-p',port,'-U','postgres','-d','postgres','-X','-qAt','-v','ON_ERROR_STOP=1','-c',query]);let stdout='',stderr='';p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);p.on('close',status=>resolve({status,stdout,stderr}));});}
const setup=`prepare fixture_setup(text) as ${SETUP_SQL}execute fixture_setup(${quote(SECRET)});`;
const config=`prepare fixture_config(text) as ${CONFIGURATION_SQL}execute fixture_config(${quote(SECRET)});`;
const parse=p=>JSON.parse(p.stdout.trim().split('\n').at(-1));
const seedRun=`insert into cron.job_run_details(jobid,status,start_time) select jobid,'running',clock_timestamp()-interval '1 second' from cron.job where jobname=${quote(JOB_NAME)};`;
const transaction=body=>sql(`begin;${body}rollback;`);
const expect=(label,body,lines)=>{const p=transaction(body);const out=p.stdout.split('\n');check(label,lines.every(line=>out.includes(line)));};
const denySetup=`do $fixture$begin begin execute ${quote(SETUP_SQL)} using ${quote(SECRET)};raise exception 'unexpected setup acceptance';exception when division_by_zero then null;end;end $fixture$;`;
try{
 pg('initdb',['-D',data,'-A','trust','-U','postgres','--no-sync']);pg('pg_ctl',['-D',data,'-w','-l',join(root,'pg.log'),'-o',`-p ${port} -k ${root} -c listen_addresses= -c fsync=off`,'start']);
 sql(`create extension pgcrypto;create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
 create schema cron;create schema net;create schema vault;
 create table cron.job(jobid bigserial primary key,schedule text not null,command text not null,nodename text not null default 'localhost',nodeport integer not null default 5432,database text not null default current_database(),username text not null default current_user,active boolean not null default true,jobname name, constraint jobname_username_uniq unique(jobname,username));
 create table cron.cache_events(n integer not null);insert into cron.cache_events values(0);
 create function cron.job_cache_invalidate() returns trigger language plpgsql as $$begin update cron.cache_events set n=n+1;return null;end$$;
 create trigger cron_job_cache_invalidate after insert or update or delete or truncate on cron.job for each statement execute function cron.job_cache_invalidate();
 create table cron.job_run_details(jobid bigint,runid bigserial primary key,status text,start_time timestamptz,end_time timestamptz);
 create table vault.secrets(id uuid primary key default gen_random_uuid(),name text unique,description text not null default '',secret text not null,key_id uuid,nonce bytea default gen_random_bytes(24),created_at timestamptz not null default now(),updated_at timestamptz not null default now());
 create view vault.decrypted_secrets as select s.*,pgp_sym_decrypt(decode(s.secret,'base64'),'public_disposable_fixture_key') decrypted_secret from vault.secrets s;
 create function vault.create_secret(new_secret text,new_name text default null,new_description text default '') returns uuid language plpgsql security definer set search_path='' as $$declare v uuid;begin insert into vault.secrets(name,description,secret)values(new_name,new_description,encode(public.pgp_sym_encrypt(new_secret,'public_disposable_fixture_key'),'base64'))returning id into v;return v;end$$;
 create unlogged table net.http_request_queue(id bigserial primary key,method text not null,url text not null,headers jsonb not null,timeout_milliseconds integer not null);
 create unlogged table net._http_response(id bigint,status_code integer,content_type text,headers jsonb,content text,timed_out boolean,error_msg text,created timestamptz not null default now());
 create function net.http_get(url text,params jsonb default '{}',headers jsonb default '{}',timeout_milliseconds integer default 5000)returns bigint language plpgsql as $$declare v bigint;begin insert into net.http_request_queue(method,url,headers,timeout_milliseconds)values('GET',url,headers,timeout_milliseconds)returning id into v;return v;end$$;
 create table public.system_health_checks(singleton boolean primary key,canary_status text,canary_failure_at timestamptz,invariants_status text,invariant_counts jsonb,last_maintenance_at timestamptz,invariants_checked_at timestamptz);
 insert into public.system_health_checks values(true,'healthy',null,'healthy','{"codeStockMismatch":0,"heldReservationMismatch":0,"liveChaseMissingReservation":0,"heldCodeMismatch":0,"orphanReservedCode":0,"unwitnessedStockReservation":0,"fanCreditMismatch":0}',now(),now());
 revoke all on schema vault,net from public,anon,authenticated,service_role;revoke all on all tables in schema vault from public,anon,authenticated,service_role;revoke all on all tables in schema net from public,anon,authenticated,service_role;revoke all on all functions in schema vault from public,anon,authenticated,service_role;revoke all on all functions in schema net from public,anon,authenticated,service_role;
 select vault.create_secret('foreign_disposable_value','foreign_owned_secret','foreign metadata');
 insert into cron.job(jobname,schedule,command,nodeport)values('foreign_owned_job','0 1 * * *','select 1',${port});`);
 check('published contract compatibility accepted',Object.values(parse(sql(CONTRACT_SQL))).filter(value=>typeof value==='boolean').every(Boolean));
 for(const role of ['anon','authenticated','service_role']){
  for(const table of ['vault.secrets','vault.decrypted_secrets','net.http_request_queue','net._http_response']){const p=sql(`set role ${role};select * from ${table};`,{allowFail:true});check(`${role} private platform table denied`,p.status!==0&&/permission denied/.test(p.stderr));}
  for(const fn of [`net.http_get('https://example.test')`,`vault.create_secret('x')`]){const p=sql(`set role ${role};select ${fn};`,{allowFail:true});check(`${role} private platform function denied`,p.status!==0&&/permission denied/.test(p.stderr));}
 }
 const partial=configurationSQL([]);const empty=parse(transaction(`drop schema vault cascade;drop schema cron cascade;prepare fixture_partial(text) as ${partial}execute fixture_partial(${quote(SECRET)});`));check('missing platform schemas are inspected without parsing nonexistent relations',empty.jobCount===0&&empty.secretCount===0);
 const matching=parse(transaction(setup+config));check('actual configuration query validates exact command, namespace and secret equality',matching.jobCount===1&&matching.jobMatches===true&&matching.secretOwned===true&&matching.secretMatches===true);
 const initial=parse(transaction(setup));check('one owned job and encrypted secret created',initial.configured&&initial.createdJob&&initial.createdSecret);
 expect('matching setup is idempotent and other jobs/secrets untouched',`${setup}deallocate fixture_setup;create temp table baseline as select secret,nonce,key_id from vault.secrets where name=${quote(VAULT_NAME)};${setup}select 'jobs:'||count(*) from cron.job;select 'foreign:'||description from vault.secrets where name='foreign_owned_secret';select 'unchanged:'||(s.secret=b.secret and s.nonce=b.nonce and s.key_id is not distinct from b.key_id) from vault.secrets s cross join baseline b where s.name=${quote(VAULT_NAME)};`,['jobs:2','foreign:foreign metadata','unchanged:true']);
 expect('setup privacy guard is atomic with secret creation',`grant select on vault.decrypted_secrets to authenticated;${denySetup}select 'owned:'||count(*) from vault.secrets where name=${quote(VAULT_NAME)};select 'jobs:'||count(*) from cron.job where jobname=${quote(JOB_NAME)};`,['owned:0','jobs:0']);
 expect('existing mismatched job is not overwritten',`insert into cron.job(jobname,schedule,command,nodeport)values(${quote(JOB_NAME)},'0 0 * * *','select 9',${port});${denySetup}select 'command:'||command from cron.job where jobname=${quote(JOB_NAME)};select 'secrets:'||count(*) from vault.secrets where name=${quote(VAULT_NAME)};`,['command:select 9','secrets:0']);
 expect('existing mismatched secret is not replaced',`select vault.create_secret('wrong_disposable_value',${quote(VAULT_NAME)},${quote(INITIAL_DESCRIPTION)});${denySetup}select 'jobs:'||count(*) from cron.job where jobname=${quote(JOB_NAME)};select 'same:'||(decrypted_secret='wrong_disposable_value') from vault.decrypted_secrets where name=${quote(VAULT_NAME)};`,['jobs:0','same:true']);
 expect('foreign description is not blessed',`select vault.create_secret(${quote(SECRET)},${quote(VAULT_NAME)},'{"owner":"foreign","version":1,"requests":[]}');${denySetup}select 'jobs:'||count(*) from cron.job where jobname=${quote(JOB_NAME)};`,['jobs:0']);
 expect('enqueue requires real running cron witness and preserves secret bytes',`${setup}${seedRun}create temp table baseline as select secret,nonce,key_id from vault.secrets where name=${quote(VAULT_NAME)};${CRON_COMMAND}select 'witnesses:'||jsonb_array_length(description::jsonb->'requests') from vault.secrets where name=${quote(VAULT_NAME)};select 'headers-private:'||(headers->>'Authorization'='Bearer '||${quote(SECRET)}) from net.http_request_queue;select 'cipher-unchanged:'||(s.secret=b.secret and s.nonce=b.nonce and s.key_id is not distinct from b.key_id) from vault.secrets s cross join baseline b where s.name=${quote(VAULT_NAME)};select 'plaintext-same:'||(decrypted_secret=${quote(SECRET)}) from vault.decrypted_secrets where name=${quote(VAULT_NAME)};`,['witnesses:1','headers-private:true','cipher-unchanged:true','plaintext-same:true']);
 expect('worker startup state already identifies its committed run row',`${setup}insert into cron.job_run_details(jobid,status)select jobid,'starting' from cron.job where jobname=${quote(JOB_NAME)};${CRON_COMMAND}select 'queued:'||count(*) from net.http_request_queue;`,['queued:1']);
 expect('missing running cron entry cannot enqueue',`${setup}do $fixture$begin begin execute ${quote(CRON_COMMAND)};raise exception 'unexpected enqueue';exception when division_by_zero then null;end;end $fixture$;select 'queued:'||count(*) from net.http_request_queue;`,['queued:0']);
 expect('unsafe API grants prevent any bearer enqueue',`${setup}${seedRun}grant select on net.http_request_queue to authenticated;do $fixture$begin begin execute ${quote(CRON_COMMAND)};raise exception 'unexpected enqueue';exception when division_by_zero then null;end;end $fixture$;select 'queued:'||count(*) from net.http_request_queue;`,['queued:0']);
 expect('invalid metadata cannot enqueue',`${setup}${seedRun}update vault.secrets set description='incompatible' where name=${quote(VAULT_NAME)};do $fixture$begin begin execute ${quote(CRON_COMMAND)};raise exception 'unexpected enqueue';exception when division_by_zero then null;end;end $fixture$;select 'queued:'||count(*) from net.http_request_queue;`,['queued:0']);
 expect('history bounded at eight and ciphertext never changes',`${setup}${seedRun}create temp table baseline as select secret,nonce from vault.secrets where name=${quote(VAULT_NAME)};${Array.from({length:10},()=>CRON_COMMAND).join('\n')}select 'history:'||jsonb_array_length(description::jsonb->'requests') from vault.secrets where name=${quote(VAULT_NAME)};select 'same:'||(s.secret=b.secret and s.nonce=b.nonce) from vault.secrets s cross join baseline b where s.name=${quote(VAULT_NAME)};`,['history:8','same:true']);
 // A noncooperating concurrent writer must never be overwritten, and a
 // newly created Vault record must roll back if the job CAS loses.
 const foreign=asyncSQL(`begin;set local application_name='maintenance_foreign';insert into cron.job(jobname,schedule,command,nodeport)values(${quote(JOB_NAME)},'0 0 * * *','select 99',${port});select pg_sleep(0.5);commit;`);
 let foreignReady=false;for(let n=0;n<40;n++){if(sql("select count(*) from pg_stat_activity where application_name='maintenance_foreign' and wait_event='PgSleep';").stdout.trim()==='1'){foreignReady=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}check('foreign job race barrier is real',foreignReady);
 const lost=await asyncSQL(setup);const wrote=await foreign;check('racing foreign job wins without overwrite',wrote.status===0&&lost.status!==0&&sql(`select command from cron.job where jobname=${quote(JOB_NAME)};`).stdout.trim()==='select 99');
 check('losing setup rolls back its new Vault record',sql(`select count(*) from vault.secrets where name=${quote(VAULT_NAME)};`).stdout.trim()==='0');
 sql(`delete from cron.job where jobname=${quote(JOB_NAME)};`);
 // Real concurrent sessions contend on the view's underlying owned Vault row.
 sql(`${setup}${seedRun}`);const fingerprint=sql(`select encode(sha256(convert_to(secret,'UTF8')),'hex')||encode(nonce,'hex') from vault.secrets where name=${quote(VAULT_NAME)};`).stdout.trim();
 const first=asyncSQL(`begin;set local application_name='maintenance_first';${CRON_COMMAND}select pg_sleep(0.6);commit;`);
 let barrier=false;for(let n=0;n<40;n++){if(sql("select count(*) from pg_stat_activity where application_name='maintenance_first' and wait_event='PgSleep';").stdout.trim()==='1'){barrier=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}check('first enqueue holds a real uncommitted Vault row lock',barrier);
 const second=asyncSQL(`begin;set local application_name='maintenance_second';${CRON_COMMAND}commit;`);
 let blocked=false;for(let n=0;n<40;n++){if(sql("select count(*) from pg_stat_activity where application_name='maintenance_second' and wait_event_type='Lock';").stdout.trim()==='1'){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}check('second enqueue really waits for the same owned Vault row',blocked);
 const results=await Promise.all([first,second]);check('concurrent enqueues both commit without lost witnesses',results.every(result=>result.status===0));
 check('two concurrent witnesses persisted',sql(`select jsonb_array_length(description::jsonb->'requests') from vault.secrets where name=${quote(VAULT_NAME)};`).stdout.trim()==='2');
 check('concurrent metadata writes preserve cipher and nonce',sql(`select encode(sha256(convert_to(secret,'UTF8')),'hex')||encode(nonce,'hex') from vault.secrets where name=${quote(VAULT_NAME)};`).stdout.trim()===fingerprint);
 const hold=asyncSQL(`begin;set local application_name='maintenance_status_hold';${CRON_COMMAND}select pg_sleep(0.4);commit;`);
 barrier=false;for(let n=0;n<40;n++){if(sql("select count(*) from pg_stat_activity where application_name='maintenance_status_hold' and wait_event='PgSleep';").stdout.trim()==='1'){barrier=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}check('status barrier reached after an uncommitted enqueue',barrier);
 const during=parse(sql(STATUS_SQL));const done=await hold;check('status sees committed metadata while enqueue is in flight',done.status===0&&during.requests.length===2&&parse(sql(STATUS_SQL)).requests.length===3);
 sql(`update cron.job_run_details set status='succeeded',end_time=clock_timestamp() where status='running';insert into net._http_response(id,status_code,content,timed_out,error_msg) select id,401,'{"private":"must_never_appear"}',false,'redacted_transport_detail' from net.http_request_queue;`);
 const failedRaw=parse(sql(STATUS_SQL));const preview={deploymentCreatedAt:0,aliasAssignedAt:0};const failed=summarizeStatus(failedRaw,preview);check('HTTP failures do not become successful scheduled execution',!failed.scheduledExecutionVerified&&!failed.requests[0].applicationCompletionVerified);
 check('status SQL never returns private HTTP bodies or errors',!JSON.stringify(failedRaw).includes('must_never_appear')&&!JSON.stringify(failedRaw).includes('redacted_transport_detail'));
 sql(`update public.system_health_checks set last_maintenance_at=clock_timestamp(),invariants_checked_at=clock_timestamp();update net._http_response set status_code=200,timed_out=false,error_msg=null,content=jsonb_build_object('ok',true,'health',jsonb_build_object('ok',true,'demo',false,'canary',jsonb_build_object('status','healthy'),'invariants',jsonb_build_object('status','healthy'),'summary',jsonb_build_object('lastMaintenanceAt',(select last_maintenance_at from public.system_health_checks where singleton))))::text,created=clock_timestamp();`);
 const successful=summarizeStatus(parse(sql(STATUS_SQL)),preview);check('exact cron, HTTP and app completion are separately correlated',successful.scheduledExecutionVerified&&successful.requests[0].enqueueVerified&&successful.requests[0].httpCompletionVerified&&successful.requests[0].applicationCompletionVerified&&successful.currentHealthHealthy);
 sql(`update net._http_response set content='{"ok":true}';`);check('a bare HTTP200 ok flag cannot masquerade as application completion',!summarizeStatus(parse(sql(STATUS_SQL)),preview).scheduledExecutionVerified);

 sql(`delete from net._http_response;update cron.job_run_details set start_time=clock_timestamp()-interval '7 hours 1 second',end_time=clock_timestamp()-interval '6 hours 59 minutes 59 seconds';update vault.secrets set description=jsonb_set(description::jsonb,'{requests}',jsonb_build_array((description::jsonb->'requests'->0)||jsonb_build_object('queuedAt',clock_timestamp()-interval '7 hours')))::text where name=${quote(VAULT_NAME)};`);
 const expired=summarizeStatus(parse(sql(STATUS_SQL)),preview);check('HTTP retention expiry is explicit and unverified',expired.requests[0].enqueueVerified&&expired.requests[0].evidenceExpired&&!expired.scheduledExecutionVerified);
 const beforeRollback=sql(`select secret||encode(nonce,'hex')||description from vault.secrets where name=${quote(VAULT_NAME)};`).stdout;
 sql(ROLLBACK_SQL);check('rollback removes only the exact owned job',sql(`select count(*) from cron.job where jobname=${quote(JOB_NAME)};`).stdout.trim()==='0'&&sql("select count(*) from cron.job where jobname='foreign_owned_job';").stdout.trim()==='1');
 check('rollback leaves encrypted secret, nonce and history unchanged',sql(`select secret||encode(nonce,'hex')||description from vault.secrets where name=${quote(VAULT_NAME)};`).stdout===beforeRollback);
 sql(ROLLBACK_SQL);checks++;
 expect('rollback refuses conflicting namespace metadata',`insert into cron.job(jobname,schedule,command,nodeport)values(${quote(JOB_NAME)},'0 0 * * *','select 7',${port});do $fixture$begin begin execute ${quote(ROLLBACK_SQL)};raise exception 'unexpected rollback';exception when raise_exception then if sqlerrm<>'maintenance rollback ownership mismatch' then raise;end if;end;end $fixture$;select 'foreign-command:'||command from cron.job where jobname=${quote(JOB_NAME)};`,['foreign-command:select 7']);
 // Assert the published-format command itself is constant, with no literal bearer.
 check('command uses Vault lookup, not credential literal',!CRON_COMMAND.includes(SECRET)&&CRON_COMMAND.includes('decrypted_secret'));
 console.log(`TEST maintenance disposable PostgreSQL: ${checks} checks passed; real row locks/crypto, fake extension workers and HTTP only`);
 console.log(`Cron command SHA256: ${createHash('sha256').update(CRON_COMMAND).digest('hex')}`);
}finally{spawnSync(join(bin,'pg_ctl'),['-D',data,'-m','immediate','stop'],{encoding:'utf8',...runAs});rmSync(root,{recursive:true,force:true});}
