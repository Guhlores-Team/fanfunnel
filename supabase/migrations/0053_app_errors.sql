-- 0053 In-house error monitoring: app_errors + app_error_alerts.
--
-- Browser and server errors are grouped by fingerprint (a hash of the
-- normalized message + top stack frame + source) per environment, so a repeat
-- bumps `count` / `last_seen` instead of adding a row. Everything stored has
-- already been redacted by the app (no fan tokens, auth tokens, emails,
-- passwords or query strings); the checks below only bound the sizes.
--
-- Access (AGENTS.md rules 2/5/6):
--   * Writes go ONLY through the server (POST /api/errors and the
--     instrumentation hook) with the service role, via record_app_error() and
--     claim_app_error_alert(). Both are revoked from public, anon and
--     authenticated. No INSERT/DELETE policy exists and no INSERT/DELETE grant
--     is given to anon or authenticated.
--   * Admins (is_admin(): role AND is_active) may SELECT and resolve. The
--     resolve UPDATE is column-limited to resolved / resolved_at by grant and
--     admin-only by policy. anon has no table privilege at all.
--
-- app_error_alerts is the alert e-mail log the global hourly throttle counts.

create table if not exists public.app_errors (
  id            uuid primary key default gen_random_uuid(),
  fingerprint   text not null check (fingerprint ~ '^[0-9a-f]{32,64}$'),
  environment   text not null check (environment in ('production', 'preview', 'development')),
  source        text not null check (source in ('client', 'server')),
  route         text check (char_length(route) <= 512),
  message       text not null check (char_length(message) <= 1000),
  stack         text check (char_length(stack) <= 8000),
  user_agent    text check (char_length(user_agent) <= 256),
  count         integer not null default 1 check (count >= 1),
  first_seen    timestamptz not null default now(),
  last_seen     timestamptz not null default now(),
  resolved      boolean not null default false,
  resolved_at   timestamptz,
  alert_pending boolean not null default false,
  constraint app_errors_env_fingerprint_key unique (environment, fingerprint)
);
create index if not exists app_errors_last_seen_idx on public.app_errors (last_seen desc);

create table if not exists public.app_error_alerts (
  id      uuid primary key default gen_random_uuid(),
  sent_at timestamptz not null default now(),
  kind    text not null check (kind in ('error', 'digest')),
  errors  integer not null default 1 check (errors >= 1)
);
create index if not exists app_error_alerts_sent_at_idx on public.app_error_alerts (sent_at desc);

alter table public.app_errors enable row level security;
alter table public.app_error_alerts enable row level security;

drop policy if exists app_errors_admin_select on public.app_errors;
create policy app_errors_admin_select on public.app_errors for select to authenticated
  using (public.is_admin());
drop policy if exists app_errors_admin_update on public.app_errors;
create policy app_errors_admin_update on public.app_errors for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists app_error_alerts_admin_select on public.app_error_alerts;
create policy app_error_alerts_admin_select on public.app_error_alerts for select to authenticated
  using (public.is_admin());

revoke all on table public.app_errors from public, anon, authenticated;
grant select on table public.app_errors to authenticated;
grant update (resolved, resolved_at) on table public.app_errors to authenticated;
revoke all on table public.app_error_alerts from public, anon, authenticated;
grant select on table public.app_error_alerts to authenticated;

-- Upsert one occurrence. A repeat bumps count/last_seen and reopens a resolved
-- row (keeping the first sample). A new row prunes the table back to
-- p_max_rows: oldest resolved rows go first, then the oldest open ones.
-- Returns {id, is_new, reopened, count, first_seen} for the alert decision.
create or replace function public.record_app_error(
  p_fingerprint text,
  p_environment text,
  p_source text,
  p_message text,
  p_route text default null,
  p_stack text default null,
  p_user_agent text default null,
  p_max_rows integer default 1000
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_new boolean := false;
  v_was_resolved boolean := false;
  v_count integer;
  v_first timestamptz;
  v_over integer;
begin
  select id, resolved into v_id, v_was_resolved from public.app_errors
   where environment = p_environment and fingerprint = p_fingerprint
   for update;
  if found then
    update public.app_errors
       set count = least(count, 2147483646) + 1,
           last_seen = now(),
           resolved = false,
           resolved_at = null
     where id = v_id
     returning count, first_seen into v_count, v_first;
  else
    v_was_resolved := false;
    insert into public.app_errors (fingerprint, environment, source, route, message, stack, user_agent)
    values (p_fingerprint, p_environment, p_source, p_route, p_message, p_stack, p_user_agent)
    on conflict (environment, fingerprint) do update
       set count = least(app_errors.count, 2147483646) + 1,
           last_seen = now()
    returning id, (xmax = 0), count, first_seen into v_id, v_new, v_count, v_first;
  end if;

  if v_new then
    select count(*) - greatest(coalesce(p_max_rows, 1000), 1) into v_over from public.app_errors;
    if v_over > 0 then
      delete from public.app_errors
       where id in (select id from public.app_errors
                     where id <> v_id
                     order by resolved desc, last_seen asc
                     limit v_over);
    end if;
  end if;

  return jsonb_build_object(
    'id', v_id,
    'is_new', v_new,
    'reopened', coalesce(v_was_resolved, false),
    'count', v_count,
    'first_seen', v_first
  );
end;
$$;

-- Global alert throttle: at most p_limit e-mails per rolling hour, across every
-- server instance (serialized by an advisory lock). With p_error_id (a new or
-- reopened error): send=true when under the limit, and `pending` counts the
-- throttled errors this e-mail also covers; over the limit the error is marked
-- alert_pending for a later digest. Without p_error_id: a digest check, send=true
-- only when under the limit AND open throttled errors are waiting.
create or replace function public.claim_app_error_alert(
  p_limit integer,
  p_error_id uuid default null
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_sent integer;
  v_pending integer;
begin
  perform pg_advisory_xact_lock(hashtext('public.app_error_alerts'));
  delete from public.app_error_alerts where sent_at < now() - interval '1 day';
  select count(*) into v_sent from public.app_error_alerts where sent_at > now() - interval '1 hour';

  if v_sent >= greatest(coalesce(p_limit, 0), 0) then
    if p_error_id is not null then
      update public.app_errors set alert_pending = true where id = p_error_id;
    end if;
    return jsonb_build_object('send', false, 'pending', 0);
  end if;

  select count(*) into v_pending from public.app_errors
   where alert_pending and not resolved and (p_error_id is null or id <> p_error_id);
  if p_error_id is null and v_pending = 0 then
    return jsonb_build_object('send', false, 'pending', 0);
  end if;
  update public.app_errors set alert_pending = false where alert_pending;

  insert into public.app_error_alerts (kind, errors)
  values (case when p_error_id is null then 'digest' else 'error' end,
          greatest(v_pending + case when p_error_id is null then 0 else 1 end, 1));
  return jsonb_build_object('send', true, 'pending', v_pending);
end;
$$;

-- Server-only: the service role calls these from the server routes. Nobody
-- signed in or anonymous may write errors or burn the alert budget.
revoke execute on function public.record_app_error(text, text, text, text, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.record_app_error(text, text, text, text, text, text, text, integer) to service_role;
revoke execute on function public.claim_app_error_alert(integer, uuid) from public, anon, authenticated;
grant execute on function public.claim_app_error_alert(integer, uuid) to service_role;
