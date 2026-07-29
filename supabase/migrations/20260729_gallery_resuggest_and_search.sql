-- ============================================================================
-- Companion helpers for the rewritten photo-gallery edge function
-- ============================================================================
-- Two SECURITY DEFINER helpers the function calls with its service-role client.
-- Both are locked to service_role (the v2 migration's blanket lockdown only
-- covered functions that existed when it ran, so new functions must revoke
-- PUBLIC/anon/authenticated for themselves).
-- ----------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Targeted re-suggest
-- ---------------------------------------------------------------------------
-- gallery_resuggest() loops over every unnamed face in plpgsql, which
-- approaches the statement timeout at a few thousand faces. This variant only
-- reconsiders faces that could newly point at p_person_id, so the function can
-- call it cheaply after a single confirmation and fall back to the full sweep
-- only on explicit request.
create or replace function public.gallery_resuggest_for_person(
  p_person_id uuid, p_max_distance real default 0.55
) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer := 0; f record; m record;
begin
  for f in
    select gf.id from public.gallery_faces gf
     where gf.person_id is null
       and (gf.suggested_person_id is null or gf.suggested_distance > p_max_distance)
  loop
    select * into m from public.gallery_match_face(f.id, p_max_distance, 1);
    if found and m.person_id = p_person_id then
      update public.gallery_faces
         set suggested_person_id = m.person_id, suggested_distance = m.distance
       where id = f.id;
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;
revoke all on function public.gallery_resuggest_for_person(uuid, real)
  from public, anon, authenticated;
grant execute on function public.gallery_resuggest_for_person(uuid, real)
  to service_role;

-- ---------------------------------------------------------------------------
-- 2. Public list + search, pushed into SQL
-- ---------------------------------------------------------------------------
-- The old function fetched every published row and filtered `q` in JavaScript.
-- PostgREST cannot express a case-insensitive SUBSTRING match against elements
-- of a text[] column, so search lives here: caption is matched with ILIKE and
-- people[] with an unnest + ILIKE. Only published rows are returned; the edge
-- function still checks the category is_public flag before calling this.
create or replace function public.gallery_list_photos(
  p_gallery text,
  p_year    int  default null,   -- null = all years
  p_q       text default null    -- null/'' = no text filter
) returns setof public.gallery_photos
language sql stable security definer set search_path = public as $$
  select p.*
    from public.gallery_photos p
   where p.gallery = p_gallery
     and p.published = true
     and (p_year is null or p.year = p_year)
     and (
       p_q is null or btrim(p_q) = ''
       or p.caption ilike '%' || p_q || '%'
       or exists (
            select 1 from unnest(p.people) as person
             where person ilike '%' || p_q || '%'
          )
     )
   order by p.taken_at asc nulls last, p.sort_order asc, p.created_at asc
   limit 2000;
$$;
revoke all on function public.gallery_list_photos(text, int, text)
  from public, anon, authenticated;
grant execute on function public.gallery_list_photos(text, int, text)
  to service_role;
