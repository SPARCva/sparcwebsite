-- ============================================================================
-- Photo gallery: people roster + face recognition v2
-- ============================================================================
-- Replaces the original gallery_faces design. This is safe to run
-- destructively: gallery_faces held 0 rows and no photo had face_scanned=true,
-- so the previous face pipeline had never produced any data.
--
-- What changes and why:
--
--  * Embeddings move from jsonb -> vector(128). Matching now happens inside
--    Postgres instead of pulling up to 20,000 JSON descriptors into the edge
--    function and looping in JavaScript.
--
--  * A real person entity (gallery_people) replaces free-text names. Renaming
--    or merging a person is now one UPDATE instead of rewriting every photo row,
--    and "Debi Alexander" / "Debi" / "debi alexander" can be the same record.
--
--  * Face boxes are stored as FRACTIONS of the image (0..1) rather than pixels.
--    The old code scanned `thumb_url || image_url` but cropped from `image_url`;
--    the moment thumbnails existed, every face crop would have misaligned.
--
--  * Naming a face no longer writes blindly across the database. Confirmed
--    faces ARE the exemplar set for a person; unnamed faces get *suggestions*
--    that a human confirms or rejects. Confirming adds another exemplar, so
--    recognition improves with use instead of being frozen at first guess.
--
--  * Rejections are remembered per (face, person), so a wrong guess is never
--    offered a second time. The old design excluded already-named faces from
--    matching entirely, which made every mistake permanent and unfixable.
--
--  * The photographer role is removed.
-- ============================================================================

create extension if not exists vector;

-- ---------------------------------------------------------------------------
-- 1. Remove the photographer role
-- ---------------------------------------------------------------------------
alter table public.photo_gallery_config drop column if exists photographer_token_sha256;

-- The original source check omitted several values the edge function actually
-- writes ('youtube'/'vimeo' from video-add), so adding a video would have
-- failed at the constraint. Rebuild the list to match reality, drop
-- 'photographer', and add 'dropbox'.
alter table public.gallery_photos drop constraint if exists gallery_photos_source_check;
update public.gallery_photos set source = 'upload'
  where source not in ('upload','google_photos','gdrive','dropbox','repo','youtube','vimeo');
alter table public.gallery_photos add constraint gallery_photos_source_check
  check (source in ('upload','google_photos','gdrive','dropbox','repo','youtube','vimeo'));

-- ---------------------------------------------------------------------------
-- 2. People roster
-- ---------------------------------------------------------------------------
create table if not exists public.gallery_people (
  id            uuid primary key default gen_random_uuid(),
  display_name  text not null,
  sort_name     text,                        -- "Alexander, Debi" for roster order
  aliases       text[] not null default '{}',-- nicknames; searched but not displayed
  kind          text not null default 'unknown'
                  check (kind in ('participant','staff','board','family','guest','unknown')),
  hidden        boolean not null default false, -- operational: omit from public tags/search
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index if not exists gallery_people_name_uniq
  on public.gallery_people (lower(display_name));
create index if not exists gallery_people_sort_idx
  on public.gallery_people (coalesce(sort_name, display_name));

alter table public.gallery_people enable row level security;
-- (no policies: service-role only, via the photo-gallery edge function)

comment on table public.gallery_people is
  'Person roster for photo tagging. One row per person; face matches and photo tags reference this by id so renames and merges are a single update.';
comment on column public.gallery_people.hidden is
  'Operational switch: when true the person is omitted from public people[] tags and public search, without deleting their face data. Use if someone later asks not to appear.';

-- ---------------------------------------------------------------------------
-- 3. Faces
-- ---------------------------------------------------------------------------
drop table if exists public.gallery_faces cascade;

create table public.gallery_faces (
  id          uuid primary key default gen_random_uuid(),
  photo_id    uuid not null references public.gallery_photos(id) on delete cascade,

  -- Set only once a human has confirmed. Confirmed faces are the exemplar set.
  person_id   uuid references public.gallery_people(id) on delete set null,

  embedding   vector(128) not null,          -- face-api.js descriptor

  -- Bounding box as fractions of the image, 0..1. Resolution-independent.
  box_x       real not null check (box_x >= -0.5 and box_x <= 1.5),
  box_y       real not null check (box_y >= -0.5 and box_y <= 1.5),
  box_w       real not null check (box_w > 0 and box_w <= 2),
  box_h       real not null check (box_h > 0 and box_h <= 2),

  origin      text not null default 'detected' check (origin in ('detected','manual')),
  detector    text not null default 'face-api/tiny',
  det_score   real,

  -- Pending machine guess, surfaced in the review queue. Never auto-applied.
  suggested_person_id uuid references public.gallery_people(id) on delete set null,
  suggested_distance  real,

  confirmed_at timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists gallery_faces_photo_idx   on public.gallery_faces (photo_id);
create index if not exists gallery_faces_person_idx  on public.gallery_faces (person_id);
create index if not exists gallery_faces_unnamed_idx on public.gallery_faces (id) where person_id is null;
create index if not exists gallery_faces_suggested_idx
  on public.gallery_faces (suggested_person_id) where person_id is null and suggested_person_id is not null;
create index if not exists gallery_faces_embedding_idx
  on public.gallery_faces using hnsw (embedding vector_l2_ops);

alter table public.gallery_faces enable row level security;

comment on table public.gallery_faces is
  'One row per detected or manually-drawn face. Descriptors are computed in-browser by face-api.js and never leave SPARC infrastructure. person_id is set only on human confirmation; confirmed rows double as that person''s exemplar set for future matching.';

-- Remembered "no, that is not this person" decisions, so a rejected guess is
-- never suggested again for the same face.
create table if not exists public.gallery_face_rejections (
  face_id    uuid not null references public.gallery_faces(id) on delete cascade,
  person_id  uuid not null references public.gallery_people(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (face_id, person_id)
);
alter table public.gallery_face_rejections enable row level security;

-- ---------------------------------------------------------------------------
-- 4. Photo <-> person links, and the denormalised people[] cache
-- ---------------------------------------------------------------------------
-- gallery_photos.people[] stays as-is so the existing public API and the
-- public gallery JS keep working unchanged. It is now a cache maintained by
-- trigger rather than something written by hand in three different places.
create table if not exists public.gallery_photo_people (
  photo_id   uuid not null references public.gallery_photos(id) on delete cascade,
  person_id  uuid not null references public.gallery_people(id) on delete cascade,
  via        text not null default 'face' check (via in ('face','manual')),
  created_at timestamptz not null default now(),
  primary key (photo_id, person_id)
);
create index if not exists gallery_photo_people_person_idx
  on public.gallery_photo_people (person_id);
alter table public.gallery_photo_people enable row level security;

create or replace function public.gallery_refresh_photo_people(p_photo_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.gallery_photos p
     set people = coalesce((
           select array_agg(distinct pe.display_name order by pe.display_name)
             from public.gallery_photo_people pp
             join public.gallery_people pe on pe.id = pp.person_id
            where pp.photo_id = p_photo_id
              and not pe.hidden
         ), '{}')
   where p.id = p_photo_id;
$$;

create or replace function public.gallery_photo_people_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.gallery_refresh_photo_people(coalesce(new.photo_id, old.photo_id));
  return coalesce(new, old);
end;
$$;

drop trigger if exists gallery_photo_people_sync_trg on public.gallery_photo_people;
create trigger gallery_photo_people_sync_trg
after insert or update or delete on public.gallery_photo_people
for each row execute function public.gallery_photo_people_sync();

-- Renaming or hiding a person refreshes every photo they appear in.
--
-- NOTE: propagation MUST run in an AFTER trigger. As a BEFORE trigger the
-- refresh reads the pre-update row, so every rename and hide landed one
-- statement late. updated_at still needs BEFORE, hence the split.
create or replace function public.gallery_person_touch()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.gallery_person_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.display_name is distinct from old.display_name
     or new.hidden is distinct from old.hidden then
    perform public.gallery_refresh_photo_people(pp.photo_id)
       from public.gallery_photo_people pp
      where pp.person_id = new.id;
  end if;
  return null;
end;
$$;

drop trigger if exists gallery_person_touch_trg on public.gallery_people;
create trigger gallery_person_touch_trg
before update on public.gallery_people
for each row execute function public.gallery_person_touch();

drop trigger if exists gallery_person_sync_trg on public.gallery_people;
create trigger gallery_person_sync_trg
after update on public.gallery_people
for each row execute function public.gallery_person_sync();

-- ---------------------------------------------------------------------------
-- 5. Matching
-- ---------------------------------------------------------------------------
-- Nearest confirmed exemplars for one unnamed face, grouped per person and
-- filtered by remembered rejections. face-api descriptors compare by Euclidean
-- distance; 0.55 is conservative, 0.6 is the library's own default.
create or replace function public.gallery_match_face(
  p_face_id      uuid,
  p_max_distance real default 0.55,
  p_limit        int  default 5
)
returns table (person_id uuid, display_name text, distance real, exemplars bigint)
language sql
stable
security definer
set search_path = public
as $$
  with src as (
    select embedding from public.gallery_faces where id = p_face_id
  )
  select f.person_id,
         pe.display_name,
         min(f.embedding <-> (select embedding from src))::real as distance,
         count(*) as exemplars
    from public.gallery_faces f
    join public.gallery_people pe on pe.id = f.person_id
   where f.person_id is not null
     and f.id <> p_face_id
     and not exists (
           select 1 from public.gallery_face_rejections r
            where r.face_id = p_face_id and r.person_id = f.person_id
         )
   group by f.person_id, pe.display_name
  having min(f.embedding <-> (select embedding from src)) <= p_max_distance
   order by distance asc
   limit p_limit;
$$;

-- Recompute suggestions for every unnamed face. Cheap to re-run; called after
-- a batch of confirmations so newly-added exemplars improve pending guesses.
create or replace function public.gallery_resuggest(p_max_distance real default 0.55)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer := 0;
  f record;
  m record;
begin
  for f in select id from public.gallery_faces where person_id is null loop
    select * into m from public.gallery_match_face(f.id, p_max_distance, 1);
    if found then
      update public.gallery_faces
         set suggested_person_id = m.person_id,
             suggested_distance  = m.distance
       where id = f.id;
      n := n + 1;
    else
      update public.gallery_faces
         set suggested_person_id = null,
             suggested_distance  = null
       where id = f.id
         and suggested_person_id is not null;
    end if;
  end loop;
  return n;
end;
$$;

-- Confirm a face as a person: sets person_id, links the photo, refreshes the
-- people[] cache, and clears any pending suggestion. Idempotent.
create or replace function public.gallery_confirm_face(p_face_id uuid, p_person_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_photo uuid;
begin
  update public.gallery_faces
     set person_id = p_person_id,
         suggested_person_id = null,
         suggested_distance  = null,
         confirmed_at = now()
   where id = p_face_id
  returning photo_id into v_photo;

  if v_photo is null then
    raise exception 'Face % not found', p_face_id;
  end if;

  insert into public.gallery_photo_people (photo_id, person_id, via)
  values (v_photo, p_person_id, 'face')
  on conflict (photo_id, person_id) do nothing;

  perform public.gallery_refresh_photo_people(v_photo);
end;
$$;

-- Reject a suggestion: remember it and clear the guess.
create or replace function public.gallery_reject_face(p_face_id uuid, p_person_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.gallery_face_rejections (face_id, person_id)
  values (p_face_id, p_person_id)
  on conflict do nothing;

  update public.gallery_faces
     set suggested_person_id = null,
         suggested_distance  = null
   where id = p_face_id
     and suggested_person_id = p_person_id;
end;
$$;

-- Unconfirm: detach a face from a person and drop the photo link if that was
-- the person's only face in the photo and it wasn't also tagged manually.
create or replace function public.gallery_unconfirm_face(p_face_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_photo  uuid;
  v_person uuid;
begin
  select photo_id, person_id into v_photo, v_person
    from public.gallery_faces where id = p_face_id;
  if v_person is null then return; end if;

  update public.gallery_faces
     set person_id = null, confirmed_at = null
   where id = p_face_id;

  delete from public.gallery_photo_people pp
   where pp.photo_id = v_photo
     and pp.person_id = v_person
     and pp.via = 'face'
     and not exists (
           select 1 from public.gallery_faces f
            where f.photo_id = v_photo and f.person_id = v_person
         );

  perform public.gallery_refresh_photo_people(v_photo);
end;
$$;

-- Merge duplicate people (e.g. "Debi" into "Debi Alexander").
create or replace function public.gallery_merge_people(p_keep uuid, p_drop uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_keep = p_drop then return; end if;

  update public.gallery_faces set person_id = p_keep where person_id = p_drop;
  update public.gallery_faces set suggested_person_id = p_keep where suggested_person_id = p_drop;

  insert into public.gallery_photo_people (photo_id, person_id, via)
  select pp.photo_id, p_keep, pp.via from public.gallery_photo_people pp
   where pp.person_id = p_drop
  on conflict (photo_id, person_id) do nothing;

  delete from public.gallery_photo_people where person_id = p_drop;

  insert into public.gallery_face_rejections (face_id, person_id)
  select r.face_id, p_keep from public.gallery_face_rejections r
   where r.person_id = p_drop
  on conflict do nothing;

  delete from public.gallery_people where id = p_drop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Housekeeping on gallery_photos
-- ---------------------------------------------------------------------------
alter table public.gallery_photos
  add column if not exists thumb_path text,        -- storage path of the 400px rendition
  add column if not exists needs_alt boolean not null default false;

-- Flag the current backlog: every existing row has empty alt_text AND empty
-- caption, so every image on the public gallery currently renders alt="".
update public.gallery_photos
   set needs_alt = true
 where coalesce(nullif(trim(alt_text), ''), nullif(trim(caption), '')) is null
   and media_type = 'photo';

comment on column public.gallery_photos.needs_alt is
  'True when the photo has neither alt_text nor caption, so it would render alt="" on the public site. Drives the alt-text backlog view in the admin.';

-- The original comment claimed no biometric data was stored, which stopped
-- being true the moment gallery_faces existed. Correct it.
comment on table public.gallery_photos is
  'Photos and embedded videos for /photogallery. Read and written only by the photo-gallery edge function (service role); RLS blocks all anon access. Public reads return published rows only. people[] is a denormalised cache maintained by trigger from gallery_photo_people. Face descriptors live in gallery_faces and are computed in-browser; they are biometric data and never leave SPARC infrastructure.';

-- ---------------------------------------------------------------------------
-- 7. Lock down RPC exposure
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER functions are auto-exposed as PostgREST RPC endpoints and
-- default to EXECUTE for PUBLIC. Because they bypass RLS, anon could otherwise
-- call /rest/v1/rpc/gallery_confirm_face or gallery_merge_people directly with
-- nothing but the publishable key. Every gallery mutation must go through the
-- photo-gallery edge function (service role).
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure::text as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname like 'gallery\_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end $$;
