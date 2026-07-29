-- ---------------------------------------------------------------------------
-- Tier 3 (staged, opt-in): a second, higher-accuracy face recognizer.
--
-- Everything here is ADDITIVE and inert until an admin opts in. The existing
-- face-api recognizer (128-float euclidean descriptors in
-- gallery_faces.embedding) keeps driving matching while
-- photo_gallery_config.recognizer = 'faceapi' (the default). Nothing below
-- changes any current behaviour.
--
-- ArcFace produces 512-float embeddings compared by COSINE distance, and is
-- markedly better at telling similar-looking people apart. Rolling it out is a
-- three-step, reversible operation the admin drives from Settings:
--   1. compute embedding_v2 for every existing face (in-browser, like scanning)
--   2. flip photo_gallery_config.recognizer to 'arcface'
--   3. the function then re-suggests using the *_v2 RPCs below
-- Switching back is just flipping the flag; the 128-float embeddings are never
-- dropped, so the face-api recognizer stays available at all times.
-- ---------------------------------------------------------------------------

-- 512-float ArcFace embedding, alongside (never replacing) the 128-float one.
alter table public.gallery_faces
  add column if not exists embedding_v2 vector(512);

comment on column public.gallery_faces.embedding_v2 is
  'ArcFace 512-float descriptor, compared by cosine distance. Populated '
  'in-browser by the high-accuracy recognizer. NULL until a face is '
  '(re-)embedded. The 128-float `embedding` is kept regardless so the face-api '
  'recognizer stays usable.';

-- Which recognizer drives matching. 'faceapi' (default) = 128-float euclidean;
-- 'arcface' = 512-float cosine via the *_v2 RPCs.
alter table public.photo_gallery_config
  add column if not exists recognizer text not null default 'faceapi';

alter table public.photo_gallery_config
  drop constraint if exists photo_gallery_config_recognizer_chk;
alter table public.photo_gallery_config
  add constraint photo_gallery_config_recognizer_chk
  check (recognizer in ('faceapi', 'arcface'));

comment on column public.photo_gallery_config.recognizer is
  'Active face recognizer: ''faceapi'' (128-float euclidean, the default) or '
  '''arcface'' (512-float cosine). The edge function routes re-suggest to the '
  'matching *_v2 RPCs when this is ''arcface''. Flip back at any time.';

-- ---------------------------------------------------------------------------
-- Matching in ArcFace / cosine space. Mirrors gallery_match_face but uses the
-- <=> cosine operator over embedding_v2, and only considers faces that HAVE a
-- v2 embedding, so a half-finished re-embed can't produce garbage matches.
-- Cosine distance is 1 - cosine similarity (range 0..2); ~0.45 is a
-- conservative ceiling for "same person" with ArcFace.
-- THRESHOLDS ARE STARTING POINTS AND NEED TUNING ON REAL DATA.
-- ---------------------------------------------------------------------------
create or replace function public.gallery_match_face_v2(
  p_face_id      uuid,
  p_max_distance real default 0.45,
  p_limit        int  default 5
)
returns table (person_id uuid, display_name text, distance real, exemplars bigint)
language sql stable security definer set search_path = public
as $$
  with src as (
    select embedding_v2 from public.gallery_faces where id = p_face_id
  )
  select f.person_id,
         pe.display_name,
         min(f.embedding_v2 <=> (select embedding_v2 from src))::real as distance,
         count(*) as exemplars
    from public.gallery_faces f
    join public.gallery_people pe on pe.id = f.person_id
   where f.person_id is not null
     and f.embedding_v2 is not null
     and f.id <> p_face_id
     and (select embedding_v2 from src) is not null
     and not exists (
           select 1 from public.gallery_face_rejections r
            where r.face_id = p_face_id and r.person_id = f.person_id
         )
   group by f.person_id, pe.display_name
  having min(f.embedding_v2 <=> (select embedding_v2 from src)) <= p_max_distance
   order by distance asc
   limit p_limit;
$$;
revoke all on function public.gallery_match_face_v2(uuid, real, int)
  from public, anon, authenticated;
grant execute on function public.gallery_match_face_v2(uuid, real, int)
  to service_role;

-- Full re-sweep in v2 space. Mirrors gallery_resuggest.
create or replace function public.gallery_resuggest_v2(p_max_distance real default 0.45)
returns integer
language plpgsql security definer set search_path = public
as $$
declare n integer := 0; f record; m record;
begin
  for f in select id from public.gallery_faces
            where person_id is null and embedding_v2 is not null loop
    select * into m from public.gallery_match_face_v2(f.id, p_max_distance, 1);
    if found then
      update public.gallery_faces
         set suggested_person_id = m.person_id, suggested_distance = m.distance
       where id = f.id;
      n := n + 1;
    else
      update public.gallery_faces
         set suggested_person_id = null, suggested_distance = null
       where id = f.id and suggested_person_id is not null;
    end if;
  end loop;
  return n;
end $$;
revoke all on function public.gallery_resuggest_v2(real) from public, anon, authenticated;
grant execute on function public.gallery_resuggest_v2(real) to service_role;

-- Targeted re-suggest in v2 space. Mirrors gallery_resuggest_for_person.
create or replace function public.gallery_resuggest_for_person_v2(
  p_person_id uuid, p_max_distance real default 0.45
) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer := 0; f record; m record;
begin
  for f in
    select gf.id from public.gallery_faces gf
     where gf.person_id is null and gf.embedding_v2 is not null
       and (gf.suggested_person_id is null or gf.suggested_distance > p_max_distance)
  loop
    select * into m from public.gallery_match_face_v2(f.id, p_max_distance, 1);
    if found and m.person_id = p_person_id then
      update public.gallery_faces
         set suggested_person_id = m.person_id, suggested_distance = m.distance
       where id = f.id;
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;
revoke all on function public.gallery_resuggest_for_person_v2(uuid, real)
  from public, anon, authenticated;
grant execute on function public.gallery_resuggest_for_person_v2(uuid, real)
  to service_role;
