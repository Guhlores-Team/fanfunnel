-- 0029 Block suspended/inactive creators from self-updating public-facing fields
-- (multi-review Audit 2 #4 — LOW). set_public_profile / set_creator_note /
-- set_chat_settings only checked `id = auth.uid()`, so a creator an admin has
-- SUSPENDED (profiles.is_active = false) could still change their public slug,
-- tagline, tip URL, note, avatar, and chat copy. Add an `is_active` guard so a
-- suspended account can't keep mutating its public presence.

create or replace function public.set_public_profile(
  p_slug text, p_tip_url text, p_tagline text
) returns void language plpgsql security definer set search_path = public as $$
begin
  update public.profiles
     set public_slug     = nullif(trim(p_slug), ''),
         tip_url         = nullif(trim(p_tip_url), ''),
         public_tagline  = nullif(trim(p_tagline), '')
   where id = auth.uid() and is_active = true;
end;
$$;

create or replace function public.set_creator_note(p_note text, p_avatar text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.profiles
     set creator_note = nullif(trim(p_note), ''),
         avatar_url    = nullif(trim(p_avatar), '')
   where id = auth.uid() and is_active = true;
end;
$$;

create or replace function public.set_chat_settings(p_intro text, p_outro text)
returns void language sql security definer set search_path = public as $$
  update public.profiles
     set chat_intro = nullif(trim(coalesce(p_intro, '')), ''),
         chat_outro = nullif(trim(coalesce(p_outro, '')), '')
   where id = auth.uid() and is_active = true;
$$;

grant execute on function public.set_chat_settings(text, text) to authenticated;
