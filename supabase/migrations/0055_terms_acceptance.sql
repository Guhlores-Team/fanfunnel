-- 0055 Terms acceptance records (creator clickwrap + fan Terms version).
--
-- Creators: profiles.terms_accepted_at / terms_version record when, and to which
-- version of the Terms of Service and Privacy Policy, the account agreed. The
-- version is LEGAL.version in src/lib/legal.ts; the dashboard asks again when it
-- is older than the current one.
--
-- Written ONLY by record_terms_acceptance(), a server-only SECURITY DEFINER
-- function: the app calls it from /api/account/terms (and the access-request
-- route) with the session user's id and the server's LEGAL.version, via the
-- service-role client. EXECUTE is revoked from public, anon and authenticated,
-- so no browser client can pick the version, backdate the timestamp (it is
-- always now()) or touch another account. A creator can't write the columns
-- directly either: the profiles UPDATE policy is admin-only (AGENTS.md rule 6).
--
-- Fans: fans.acked_terms_version records the Terms version a fan agreed to at
-- the age/terms gate. Set server-side by /api/fans/ack (service role, scoped to
-- the fan behind the token). A fan whose version is not the current one sees
-- the gate again and can't spin until they agree.

alter table public.profiles add column if not exists terms_accepted_at timestamptz;
alter table public.profiles add column if not exists terms_version text;
alter table public.fans add column if not exists acked_terms_version text;

create or replace function public.record_terms_acceptance(p_user uuid, p_version text)
returns timestamptz
language plpgsql security definer set search_path = public as $$
declare
  v_at timestamptz;
begin
  if p_user is null or p_version is null or p_version !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'invalid terms acceptance' using errcode = '22023';
  end if;
  update public.profiles
     set terms_accepted_at = now(), terms_version = p_version
   where id = p_user
  returning terms_accepted_at into v_at;
  return v_at;
end;
$$;

revoke execute on function public.record_terms_acceptance(uuid, text) from public, anon, authenticated;
grant execute on function public.record_terms_acceptance(uuid, text) to service_role;
