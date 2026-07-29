-- ---------------------------------------------------------------------------
-- Two gaps found while rebuilding the admin UI.
--
-- 1. gallery_unreject_face — undo a rejected face suggestion.
--
--    gallery_reject_face records (face_id, person_id) in
--    gallery_face_rejections, and gallery_match_face excludes any pair listed
--    there. That is deliberate: a wrong guess should never come back. But it
--    also made Reject the one irreversible action in the whole triage flow, so
--    a single mis-tap permanently stopped that person from ever being suggested
--    for that face. This restores the pair and immediately re-runs matching, so
--    the suggestion can reappear.
--
-- 2. gallery_set_thumb — attach a thumbnail to an existing row.
--
--    The `import` action re-hosts external images but leaves thumb_path null,
--    and nothing could ever fill it in: upload-urls only mints paths for brand
--    new UUIDs, and the update handler's field allowlist rejects thumb_path. So
--    imported photos served their full-size image into every grid. This lets
--    the edge function record a thumbnail the browser has rendered and PUT.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Undo a rejection
-- ---------------------------------------------------------------------------
-- Returns the restored suggestion (if any) so the caller can tell the user
-- whether the guess actually came back — it may not, if the person's exemplars
-- have since changed or another rejection still applies.
create or replace function public.gallery_unreject_face(
  p_face_id uuid, p_person_id uuid, p_max_distance real default 0.55
) returns table (person_id uuid, display_name text, distance real)
language plpgsql security definer set search_path = public as $$
declare m record;
begin
  delete from public.gallery_face_rejections r
   where r.face_id = p_face_id and r.person_id = p_person_id;

  -- Only re-suggest for a face nobody has named; a confirmed face must keep
  -- the name it was given.
  if exists (select 1 from public.gallery_faces gf
              where gf.id = p_face_id and gf.person_id is null) then
    -- gallery_match_face already excludes any pair still in the rejections
    -- table, so this picks the best remaining candidate.
    select * into m from public.gallery_match_face(p_face_id, p_max_distance, 1);
    if found then
      update public.gallery_faces
         set suggested_person_id = m.person_id, suggested_distance = m.distance
       where id = p_face_id;
      return query select m.person_id, m.display_name, m.distance;
    end if;
  end if;
  return;
end $$;

comment on function public.gallery_unreject_face(uuid, uuid, real) is
  'Undo gallery_reject_face: drop the (face, person) rejection and recompute '
  'that face''s suggestion. Returns the restored suggestion, or no rows if '
  'nothing matches within p_max_distance.';

-- New functions must lock themselves down: the v2 migration''s blanket revoke
-- only covered functions that existed when it ran, and SECURITY DEFINER
-- functions are otherwise exposed as RPCs to anon.
revoke all on function public.gallery_unreject_face(uuid, uuid, real)
  from public, anon, authenticated;
grant execute on function public.gallery_unreject_face(uuid, uuid, real)
  to service_role;

-- ---------------------------------------------------------------------------
-- 2. Attach a thumbnail to an existing photo
-- ---------------------------------------------------------------------------
-- Deliberately narrow: it only ever sets thumb_path/thumb_url, and only on a
-- row whose thumb_path is currently null, so it cannot be used to repoint an
-- existing thumbnail at another object. Returns true when a row was updated.
create or replace function public.gallery_set_thumb(
  p_photo_id uuid, p_thumb_path text, p_thumb_url text
) returns boolean
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if p_thumb_path is null or btrim(p_thumb_path) = '' then
    return false;
  end if;
  update public.gallery_photos
     set thumb_path = p_thumb_path,
         thumb_url  = p_thumb_url
   where id = p_photo_id
     and thumb_path is null;
  get diagnostics n = row_count;
  return n > 0;
end $$;

comment on function public.gallery_set_thumb(uuid, text, text) is
  'Records a browser-rendered 400px thumbnail for a photo that has none '
  '(imports leave thumb_path null). Only fills a null thumb_path, so it can '
  'never repoint an existing thumbnail.';

revoke all on function public.gallery_set_thumb(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.gallery_set_thumb(uuid, text, text)
  to service_role;
