-- Manual rollback ONLY through the pinned TEST Management endpoint. Never
-- executed by setup/status or the workflow. Keeps Vault/history/extensions.
do $rollback$
declare item cron.job%rowtype; n integer;
begin
 perform pg_advisory_xact_lock(hashtextextended('fanfunnel-test-maintenance-platform-v1',0));
 select count(*) into n from cron.job where jobname='fanfunnel.test.maintenance.v1';
 if n=0 then return;end if;
 if n<>1 then raise exception 'maintenance rollback namespace conflict';end if;
 select * into item from cron.job where jobname='fanfunnel.test.maintenance.v1' for update;
 if item.username<>'postgres' or item.database<>current_database() or item.nodename<>'localhost' or item.nodeport<>current_setting('port')::integer or item.schedule<>'17 4 * * *'
 or encode(sha256(convert_to(item.command,'UTF8')),'hex')<>'45513738e74a582a94e4064ea872b9dc480e5b794d414dec67b5e76e2348ff06'
 then raise exception 'maintenance rollback ownership mismatch';end if;
 delete from cron.job where jobid=item.jobid and jobname='fanfunnel.test.maintenance.v1' and username='postgres';
end $rollback$;
