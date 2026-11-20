// Fixed TEST platform configuration only. No public/app schema objects or
// migration numbers are added. Secret values are Management API parameters.
import {createHash} from 'node:crypto';
import {JOB_NAME,VAULT_NAME,OWNER,SCHEDULE,STABLE_ORIGIN,MAINTENANCE_PATH,HTTP_TIMEOUT_MS,REQUEST_HISTORY_LIMIT} from './test-maintenance-guards.mjs';
const literal=value=>`'${value.replaceAll("'","''")}'`;
const job=literal(JOB_NAME),name=literal(VAULT_NAME),owner=literal(OWNER);
export const INITIAL_DESCRIPTION=JSON.stringify({owner:OWNER,version:1,requests:[]});
export function metadataSQL(column){return`case when pg_input_is_valid(${column},'jsonb') then ${column}::jsonb else null end`;}
export function validMetadataSQL(meta){return`case when jsonb_typeof(${meta})='object' and jsonb_typeof(${meta}->'requests')='array' then
 (${meta}->>'owner'=${owner} and ${meta}->'version'='1'::jsonb and (select count(*) from jsonb_object_keys(${meta}))=3
 and jsonb_array_length(${meta}->'requests')<=${REQUEST_HISTORY_LIMIT}
 and not exists(select 1 from jsonb_array_elements(${meta}->'requests') r where
  case when jsonb_typeof(r)='object' then
   (select count(*) from jsonb_object_keys(r))<>3 or jsonb_typeof(r->'requestId')<>'string' or jsonb_typeof(r->'runId')<>'string' or jsonb_typeof(r->'queuedAt')<>'string' or coalesce(r->>'requestId','')!~'^[1-9][0-9]{0,18}$' or coalesce(r->>'runId','')!~'^[1-9][0-9]{0,18}$'
   or not pg_input_is_valid(coalesce(r->>'queuedAt',''),'timestamptz')
  else true end)
 and (select count(distinct r->>'requestId') from jsonb_array_elements(${meta}->'requests') r)=jsonb_array_length(${meta}->'requests'))
 else false end`;}
const valid=column=>validMetadataSQL(column);
export const PRIVATE_ACCESS_UNSAFE=`exists(select 1 from pg_namespace n cross join pg_roles r where r.rolname in('anon','authenticated','service_role') and n.nspname in('net','vault') and (
 has_schema_privilege(r.oid,n.oid,'USAGE') or exists(select 1 from pg_class c where c.relnamespace=n.oid and c.relkind in('r','v','m','p') and (has_table_privilege(r.oid,c.oid,'SELECT') or has_table_privilege(r.oid,c.oid,'INSERT') or has_table_privilege(r.oid,c.oid,'UPDATE') or has_table_privilege(r.oid,c.oid,'DELETE')))
 or exists(select 1 from pg_proc p where p.pronamespace=n.oid and has_function_privilege(r.oid,p.oid,'EXECUTE'))))`;
export const CRON_JOB_WRITE_UNSAFE=`exists(select 1 from pg_roles r where r.rolname in('anon','authenticated','service_role') and (has_table_privilege(r.oid,to_regclass('cron.job'),'INSERT') or has_table_privilege(r.oid,to_regclass('cron.job'),'UPDATE') or has_table_privilege(r.oid,to_regclass('cron.job'),'DELETE'))) `;
export const CRON_COMMAND=`with secure as materialized (
 select 1 where not ${PRIVATE_ACCESS_UNSAFE} and not ${CRON_JOB_WRITE_UNSAFE} and not exists(select 1 from pg_trigger where tgrelid='vault.secrets'::regclass and not tgisinternal)
), owned as materialized (
 select v.id,v.name,v.description,v.decrypted_secret,${metadataSQL('v.description')} meta
 from vault.decrypted_secrets v cross join secure where v.name=${name} for update of v
), running as materialized (
 select d.runid from cron.job_run_details d join cron.job j on j.jobid=d.jobid
 where j.jobname=${job} and j.username='postgres' and j.database=current_database() and j.active
 and d.status in('starting','connecting','sending','running') and d.end_time is null and (d.start_time is null or d.start_time>=clock_timestamp()-interval '10 minutes')
 order by d.runid desc limit 1
), queued as materialized (
 select o.id,o.description,o.meta,r.runid,clock_timestamp() queued_at,
 net.http_get(url:=${literal(STABLE_ORIGIN+MAINTENANCE_PATH)},headers:=jsonb_build_object('Authorization','Bearer '||o.decrypted_secret),timeout_milliseconds:=${HTTP_TIMEOUT_MS}) request_id
 from owned o cross join running r
 where ${valid('o.meta')} and length(o.decrypted_secret) between 32 and 256
), recorded as (
 update vault.secrets s set description=(q.meta||jsonb_build_object('requests',(
  select jsonb_agg(x.item order by x.rank) from (
   select jsonb_build_object('requestId',q.request_id::text,'runId',q.runid::text,'queuedAt',q.queued_at) item,0::bigint rank
   union all select item,n from jsonb_array_elements(q.meta->'requests') with ordinality old(item,n) where n<${REQUEST_HISTORY_LIMIT}
  ) x
 )))::text,updated_at=clock_timestamp()
 from queued q where s.id=q.id and s.name=${name}
 returning q.request_id
)
select 1/(case when count(*)=1 then 1 else 0 end) as enqueue_recorded from recorded;`;
export const PLATFORM_INSPECTION_SQL=`select jsonb_build_object(
 'database',current_database(),'actor',current_user,
 'cronSettingsCompatible',coalesce(current_setting('cron.database_name',true),current_database())=current_database() and coalesce(current_setting('cron.timezone',true),'GMT') in('GMT','UTC','Etc/UTC') and coalesce(current_setting('cron.log_run',true),'on') in('on','true'),
 'extensionsSchemaReady',to_regnamespace('extensions') is not null,
 'applicationReady',to_regclass('public.system_health_checks') is not null and to_regprocedure('public.run_reward_ledger_invariants(integer)') is not null,
 'extensions',coalesce((select jsonb_agg(jsonb_build_object('name',a.name,'availableVersion',a.default_version,'installedVersion',e.extversion) order by a.name)
 from pg_available_extensions a left join pg_extension e on e.extname=a.name where a.name in('pg_cron','pg_net','supabase_vault')),'[]'::jsonb),
 'unexpectedSchemas',coalesce((select jsonb_agg(n.nspname) from pg_namespace n where n.nspname in('cron','net','vault') and not exists(select 1 from pg_extension e where e.extname=case n.nspname when 'cron' then 'pg_cron' when 'net' then 'pg_net' else 'supabase_vault' end)),'[]'::jsonb),
 'unsafeCronJobWriters',${CRON_JOB_WRITE_UNSAFE},
 'vaultMetadataOnly',not exists(select 1 from pg_trigger where tgrelid=to_regclass('vault.secrets') and not tgisinternal),
 'existingCronContract',not exists(select 1 from pg_extension where extname='pg_cron') or (exists(select 1 from pg_constraint where conrelid=to_regclass('cron.job') and conname='jobname_username_uniq' and contype='u') and exists(select 1 from pg_trigger t join pg_proc p on p.oid=t.tgfoid join pg_namespace n on n.oid=p.pronamespace where t.tgrelid=to_regclass('cron.job') and t.tgname='cron_job_cache_invalidate' and t.tgenabled<>'D' and n.nspname='cron' and p.proname='job_cache_invalidate')),
 'unsafeExtensions',coalesce((select jsonb_agg(distinct n.nspname) from pg_namespace n cross join pg_roles r
 where r.rolname in('anon','authenticated','service_role') and n.nspname in('net','vault') and (
 has_schema_privilege(r.oid,n.oid,'USAGE') or exists(select 1 from pg_class c where c.relnamespace=n.oid and c.relkind in('r','v','m','p') and (has_table_privilege(r.oid,c.oid,'SELECT') or has_table_privilege(r.oid,c.oid,'INSERT') or has_table_privilege(r.oid,c.oid,'UPDATE') or has_table_privilege(r.oid,c.oid,'DELETE')))
 or exists(select 1 from pg_proc p where p.pronamespace=n.oid and has_function_privilege(r.oid,p.oid,'EXECUTE'))
 )),'[]'::jsonb)
) result;`;
export function platformEnableSQL(installed){
 const blocks=[['pg_cron','pg_catalog','cron'],['pg_net','extensions','net'],['supabase_vault','vault','vault']].map(([extension,schema,objects])=>{
  if(installed.includes(extension))return`if not exists(select 1 from pg_extension where extname='${extension}') then raise exception 'platform state changed';end if;`;
  return`if exists(select 1 from pg_extension where extname='${extension}') then raise exception 'platform state changed';end if;
  create extension ${extension} with schema ${schema};
  revoke all on schema ${objects} from public,anon,authenticated,service_role;
  revoke all on all tables in schema ${objects} from public,anon,authenticated,service_role;
  revoke all on all sequences in schema ${objects} from public,anon,authenticated,service_role;
  revoke all on all functions in schema ${objects} from public,anon,authenticated,service_role;
  grant usage on schema ${objects} to postgres;
  grant all on all tables in schema ${objects} to postgres;
  grant all on all sequences in schema ${objects} to postgres;
  grant execute on all functions in schema ${objects} to postgres;`;
 }).join('\n');
 return`do $$begin perform pg_advisory_xact_lock(hashtextextended('fanfunnel-test-maintenance-platform-v1',0));${blocks}end $$;`;
}
export const CONTRACT_SQL=`select jsonb_build_object(
 'cronContract',exists(select 1 from pg_constraint where conrelid='cron.job'::regclass and conname='jobname_username_uniq' and contype='u') and exists(select 1 from pg_trigger t join pg_proc p on p.oid=t.tgfoid join pg_namespace n on n.oid=p.pronamespace where t.tgrelid='cron.job'::regclass and t.tgname='cron_job_cache_invalidate' and t.tgenabled<>'D' and n.nspname='cron' and p.proname='job_cache_invalidate'),
 'vaultMetadataOnly',not exists(select 1 from pg_trigger where tgrelid='vault.secrets'::regclass and not tgisinternal),
 'timezone',coalesce(current_setting('cron.timezone',true),'GMT'),
 'cronDatabase',coalesce(current_setting('cron.database_name',true),current_database()),
 'runLogging',coalesce(current_setting('cron.log_run',true),'on') in('on','true'),
 'postgresAccess',has_schema_privilege('postgres','net','USAGE') and has_schema_privilege('postgres','vault','USAGE') and has_function_privilege('postgres','net.http_get(text,jsonb,jsonb,integer)','EXECUTE') and has_table_privilege('postgres','vault.secrets','UPDATE') and has_table_privilege('postgres','vault.decrypted_secrets','SELECT')
) result;`;
const safeExistingJob=`j.jobname=${job} and j.schedule=${literal(SCHEDULE)} and j.command=${literal(CRON_COMMAND)} and j.active and j.username='postgres' and j.database=current_database() and j.nodename='localhost' and j.nodeport=current_setting('port')::integer`;
export const CONFIGURATION_SQL=`with owned as materialized (
 select v.id,v.description,v.decrypted_secret,${metadataSQL('v.description')} meta from vault.decrypted_secrets v where v.name=${name}
), jobs as materialized (select * from cron.job where jobname=${job})
select jsonb_build_object(
 'jobCount',(select count(*) from jobs),'jobMatches',(select count(*)=1 and bool_and(${safeExistingJob}) from jobs j),
 'secretCount',(select count(*) from owned),'secretOwned',(select count(*)=1 and bool_and(${valid('o.meta')}) from owned o),
 'secretMatches',(select count(*)=1 and bool_and(o.decrypted_secret=$1::text) from owned o)
) result;`;
export function configurationSQL(installed){
 let query=CONFIGURATION_SQL;
 if(!installed.includes('supabase_vault'))query=query.replace("select v.id,v.description,v.decrypted_secret,"+metadataSQL('v.description')+" meta from vault.decrypted_secrets v where v.name="+name,"select null::uuid id,null::text description,null::text decrypted_secret,null::jsonb meta where false");
 if(!installed.includes('pg_cron'))query=query.replace("select * from cron.job where jobname="+job,"select null::text jobname,null::text schedule,null::text command,false active,null::text username,null::text database,null::text nodename,0 nodeport where false");
 return query;
}
export const SETUP_SQL=`with fence as materialized (
 select pg_advisory_xact_lock(hashtextextended('fanfunnel-test-maintenance-platform-v1',0))
), owned as materialized (
 select v.id,v.name,v.description,v.decrypted_secret,${metadataSQL('v.description')} meta from vault.decrypted_secrets v cross join fence where v.name=${name} for update of v
), jobs as materialized (select j.* from cron.job j cross join fence where j.jobname=${job}), accepted as materialized (
 select 1 ok from fence where length($1::text) between 32 and 256
 and not ${PRIVATE_ACCESS_UNSAFE} and not ${CRON_JOB_WRITE_UNSAFE}
 and not exists(select 1 from pg_trigger where tgrelid='vault.secrets'::regclass and not tgisinternal)
 and ((select count(*) from owned)=0 or (select count(*)=1 and bool_and(${valid('o.meta')} and o.decrypted_secret=$1::text) from owned o))
 and ((select count(*) from jobs)=0 or (select count(*)=1 and bool_and(${safeExistingJob}) from jobs j))
), created_secret as materialized (
 select vault.create_secret($1::text,${name},${literal(INITIAL_DESCRIPTION)}) id from accepted where not exists(select 1 from owned)
), inserted_job as (
 insert into cron.job(jobname,schedule,command,database,username,nodename,nodeport,active)
 select ${job},${literal(SCHEDULE)},${literal(CRON_COMMAND)},current_database(),'postgres','localhost',current_setting('port')::integer,true from accepted
 where not exists(select 1 from jobs) and (exists(select 1 from owned) or exists(select 1 from created_secret))
 on conflict on constraint jobname_username_uniq do nothing returning jobid
), outcome as materialized (
 select exists(select 1 from accepted) and (exists(select 1 from inserted_job) or exists(select 1 from jobs)) ok
)
select jsonb_build_object('guard',1/(case when ok then 1 else 0 end),'configured',ok,'createdJob',exists(select 1 from inserted_job),'createdSecret',exists(select 1 from created_secret)) result from outcome;`;
export const STATUS_SQL=`with owned as materialized (
 select v.id,${metadataSQL('v.description')} meta from vault.secrets v where v.name=${name}
), request_rows as materialized (
 select r from owned o cross join lateral jsonb_array_elements(case when ${valid('o.meta')} then o.meta->'requests' else '[]'::jsonb end) r
), evidence as (
 select r->>'requestId' request_id,r->>'runId' run_id,r->>'queuedAt' queued_at,
 d.status sql_status,d.start_time,d.end_time,
 h.id is not null response_present,h.status_code,h.timed_out,h.error_msg is not null transport_error,h.created completed_at,
 case when pg_input_is_valid(coalesce(h.content,''),'jsonb') then h.content::jsonb->'ok'='true'::jsonb and h.content::jsonb->'health'->'ok'='true'::jsonb and h.content::jsonb->'health'->'demo'='false'::jsonb and h.content::jsonb->'health'->'canary'->>'status'='healthy' and h.content::jsonb->'health'->'invariants'->>'status'='healthy' else false end application_ok,
 case when pg_input_is_valid(coalesce(h.content,''),'jsonb') then h.content::jsonb->'health'->'summary'->>'lastMaintenanceAt' end application_completed_at
 from request_rows left join cron.job j on j.jobname=${job} and j.username='postgres'
 left join cron.job_run_details d on d.jobid=j.jobid and d.runid::text=r->>'runId'
 left join lateral (select h.* from net._http_response h where h.id::text=r->>'requestId' and h.created>=current_timestamp-interval '6 hours' order by h.created desc limit 1) h on true
)
select jsonb_build_object(
 'checkedAt',clock_timestamp(),
 'requests',coalesce((select jsonb_agg(jsonb_build_object('requestId',request_id,'runId',run_id,'queuedAt',queued_at,'cronStatus',sql_status,'cronStartedAt',start_time,'cronEndedAt',end_time,'responsePresent',response_present,'httpStatus',status_code,'timedOut',timed_out,'transportError',transport_error,'httpCompletedAt',completed_at,'applicationOk',coalesce(application_ok,false),'applicationCompletedAt',application_completed_at) order by queued_at desc) from evidence),'[]'::jsonb),
 'health',(select jsonb_build_object('canaryStatus',canary_status,'canaryFailureAt',canary_failure_at,'invariantsStatus',invariants_status,'invariantCounts',invariant_counts,'lastMaintenanceAt',last_maintenance_at,'invariantsCheckedAt',invariants_checked_at) from public.system_health_checks where singleton)
) result;`;

export const ROLLBACK_SQL=`-- Manual rollback ONLY through the pinned TEST Management endpoint. Never
-- executed by setup/status or the workflow. Keeps Vault/history/extensions.
do $rollback$
declare item cron.job%rowtype; n integer;
begin
 perform pg_advisory_xact_lock(hashtextextended('fanfunnel-test-maintenance-platform-v1',0));
 select count(*) into n from cron.job where jobname=${job};
 if n=0 then return;end if;
 if n<>1 then raise exception 'maintenance rollback namespace conflict';end if;
 select * into item from cron.job where jobname=${job} for update;
 if item.username<>'postgres' or item.database<>current_database() or item.nodename<>'localhost' or item.nodeport<>current_setting('port')::integer or item.schedule<>${literal(SCHEDULE)}
 or encode(sha256(convert_to(item.command,'UTF8')),'hex')<>${literal(createHash('sha256').update(CRON_COMMAND).digest('hex'))}
 then raise exception 'maintenance rollback ownership mismatch';end if;
 delete from cron.job where jobid=item.jobid and jobname=${job} and username='postgres';
end $rollback$;`;
