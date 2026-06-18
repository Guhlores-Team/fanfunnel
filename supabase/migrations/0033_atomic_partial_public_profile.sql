-- 0033 Atomic partial updates for public-profile fields (multi-review follow-up:
-- public-profile PUT TOCTOU race + omitted note/avatar wipe). set_public_profile
-- and set_creator_note previously overwrote every column unconditionally, so the
-- route had to read-modify-write (which races concurrent partial updates) and an
-- omitted note/avatar was silently cleared. Redefine both so a NULL argument
-- means "leave this column unchanged" while a non-NULL argument sets it (an empty
-- string still clears it, via nullif). The route can then send only the fields
-- present in the request and update exactly those, atomically, in one statement.

create or replace function public.set_public_profile(
  p_slug text, p_tip_url text, p_tagline text
) returns void language plpgsql security definer set search_path = public as $$
begin
  update public.profiles
     set public_slug    = case when p_slug    is null then public_slug    else nullif(trim(p_slug), '')    end,
         tip_url        = case when p_tip_url  is null then tip_url        else nullif(trim(p_tip_url), '')  end,
         public_tagline = case when p_tagline  is null then public_tagline else nullif(trim(p_tagline), '') end
   where id = auth.uid() and is_active = true;
end;
$$;

create or replace function public.set_creator_note(p_note text, p_avatar text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.profiles
     set creator_note = case when p_note   is null then creator_note else nullif(trim(p_note), '')   end,
         avatar_url   = case when p_avatar is null then avatar_url   else nullif(trim(p_avatar), '') end
   where id = auth.uid() and is_active = true;
end;
$$;
