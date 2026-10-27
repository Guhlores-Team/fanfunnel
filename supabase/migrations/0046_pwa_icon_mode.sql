-- 0046 Home-screen icon for a fan's installed spin link (RM-4, owner decision D8).
--
-- A fan can add their personal /spin/<token> link to their phone's home screen.
-- The per-link web app manifest names the app and picks its icon from this
-- creator setting:
--   'neutral' (default) a wheel glyph in the brand colour, named "Spins", so an
--             adult creator's face and name are not on the fan's home screen;
--   'avatar'  the creator's avatar and display name.
--
-- profiles UPDATE is admin-only (AGENTS.md rule 6: no role / features
-- escalation), so the creator writes it through a narrow SECURITY DEFINER
-- setter on their OWN row, the set_creator_note pattern (0033), refused for
-- suspended accounts (is_active) and not executable by anon (the 0044 pattern).
-- The fan-facing read (manifest + icon routes) uses the service client
-- server-side, keyed by the link token; no new table, so no new policy.

alter table public.profiles
  add column if not exists pwa_icon_mode text not null default 'neutral'
    check (pwa_icon_mode in ('neutral', 'avatar'));

create or replace function public.set_pwa_icon_mode(p_mode text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_mode is null or p_mode not in ('neutral', 'avatar') then
    raise exception 'invalid pwa_icon_mode' using errcode = '22023';
  end if;
  update public.profiles set pwa_icon_mode = p_mode
   where id = auth.uid() and is_active = true;
end;
$$;

revoke execute on function public.set_pwa_icon_mode(text) from public, anon;
grant execute on function public.set_pwa_icon_mode(text) to authenticated;
