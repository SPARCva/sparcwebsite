-- ============================================================================
-- Photo gallery: match quality — face gating, robust scoring, margin test,
-- and the collapse of the v1/v2 recognizer fork.
-- ============================================================================
-- Four changes, all reversible without a revert migration (see ROLLBACK below).
--
--  1. QUALITY GATING. Every detector output currently becomes a matchable row,
--     including 15px background faces at minConfidence 0.3. Those produce
--     garbage descriptors that clutter the review queue and, once confirmed,
--     permanently corrupt a person's exemplar set. `gallery_faces.quality`
--     marks them 'low': still visible and taggable in the library, but never
--     an exemplar, never a match source, never in a queue.
--
--  2. ROBUST SCORING. Matching scored a person by min() over their exemplars —
--     the most outlier-sensitive aggregate available. One bad confirm dragged
--     that person's floor down and they started winning matches everywhere.
--     Scoring is now the mean of the p_k nearest exemplars (default 3).
--     NOTE: a mean-of-k is always >= the min it replaces, so the distance
--     ceilings are loosened to compensate. THEY NEED TUNING ON REAL DATA.
--
--  3. MARGIN TEST. Suggestions were top-1 by absolute distance, so Debi at
--     0.44 beat Kat at 0.45 and the result was labelled "Likely". A suggestion
--     is now only written when the best candidate beats the runner-up by
--     p_min_margin; otherwise the face goes to "Who is this?" as genuinely
--     ambiguous. A wrong-but-confident suggestion is worse than none, because
--     it is the one that gets accepted and then poisons the exemplar set.
--
--  4. ONE RECOGNIZER PATH. gallery_*_v2 duplicated every matching function so
--     the edge function could route by photo_gallery_config.recognizer. Three
--     callsites never got the routing (gallery_unreject_face hardcoded the v1
--     RPC *and* a 0.55 euclidean threshold; hFaceAddManual called the v1
--     re-suggest), so flipping to ArcFace silently mixed metric spaces. The
--     functions now read the active recognizer themselves and branch
--     internally. The _v2 names are dropped; the edge function stops routing.
--     Switching recognizers remains a single config flip, and dropping
--     face-api later is a two-line edit to gallery_recognizer_params().
--
-- ROLLBACK without reverting: calling the functions with p_k => 1 and
-- p_min_margin => 0 reproduces the old min()/top-1 behaviour exactly, and
-- `update gallery_faces set quality = 'ok'` un-gates every face.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Face quality
-- ---------------------------------------------------------------------------
alter table public.gallery_faces
  add column if not exists quality text not null default 'ok';

alter table public.gallery_faces
  drop constraint if exists gallery_faces_quality_chk;
alter table public.gallery_faces
  add constraint gallery_faces_quality_chk check (quality in ('ok', 'low'));

comment on column public.gallery_faces.quality is
  '''low'' = too small or too weakly detected to produce a trustworthy '
  'descriptor. Low faces are excluded from matching (as source AND as '
  'exemplar) and from the review queues, but remain visible and manually '
  'taggable in the library. Set by the client at scan time, which knows the '
  'face size in pixels; the server enforces a coarse floor as a backstop.';

-- Queue lookups always filter on these three together.
drop index if exists public.gallery_faces_unnamed_idx;
create index if not exists gallery_faces_queue_idx
  on public.gallery_faces (created_at)
  where person_id is null and quality = 'ok';

create index if not exists gallery_faces_exemplar_idx
  on public.gallery_faces (person_id)
  where person_id is not null and quality = 'ok';

-- Backfill existing rows. The client-side gate is authoritative because it
-- knows pixel dimensions; this is a one-time approximation from the stored
-- box fraction (0.03 of a 1600px render is ~48px) and detector score.
--
-- Only UNCONFIRMED faces are demoted automatically. Confirmed faces are a
-- human's work and a tiny confirmed face is exactly the poisoning case worth
-- looking at by hand — inspect and demote deliberately:
--
--   select f.id, p.display_name, f.box_w, f.det_score, ph.image_url
--     from gallery_faces f
--     join gallery_people p on p.id = f.person_id
--     join gallery_photos ph on ph.id = f.photo_id
--    where f.person_id is not null
--      and (f.box_w < 0.03 or coalesce(f.det_score, 1) < 0.5)
--    order by f.box_w;
--
-- Demoting a confirmed face removes it as an exemplar but KEEPS the photo tag,
-- because gallery_photo_people is a separate table.
update public.gallery_faces
   set quality = 'low'
 where person_id is null
   and origin = 'detected'
   and (box_w < 0.03 or coalesce(det_score, 1) < 0.5);

-- A gated face must not keep a stale suggestion sitting in the queue.
update public.gallery_faces
   set suggested_person_id = null, suggested_distance = null
 where quality = 'low'
   and suggested_person_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Active recognizer + its tuning parameters, in one place
-- ---------------------------------------------------------------------------
-- face-api: 128-float, EUCLIDEAN (<->), range 0..~1.4
-- arcface:  512-float, COSINE    (<=>), range 0..2
--
-- ceiling — the widest distance that may become a suggestion at all
-- margin  — how far the best candidate must beat the runner-up
--
-- Both are STARTING POINTS. Tune them against real confirmations: raise the
-- ceiling if true matches are landing in "Who is this?", raise the margin if
-- confident suggestions are turning out wrong.
create or replace function public.gallery_recognizer_params(p_rec text default null)
returns table (recognizer text, ceiling real, margin real)
language sql stable security definer set search_path = public
as $$
  with r as (
    select coalesce(
      p_rec,
      (select c.recognizer from public.photo_gallery_config c limit 1),
      'faceapi'
    ) as rec
  )
  select r.rec,
         case r.rec when 'arcface' then 0.48::real else 0.58::real end,
         case r.rec when 'arcface' then 0.04::real else 0.05::real end
    from r;
$$;

comment on function public.gallery_recognizer_params(text) is
  'Single source of truth for which recognizer is live and how it is tuned. '
  'The distance ceilings are looser than the pre-2026-08-03 values because '
  'scoring moved from min() to a mean of the k nearest exemplars.';

-- ---------------------------------------------------------------------------
-- 3. Matching
-- ---------------------------------------------------------------------------
-- Old signatures are dropped rather than replaced: adding defaulted arguments
-- to an existing function creates an OVERLOAD, and a 3-argument call would
-- then be ambiguous between the two.
drop function if exists public.gallery_match_face(uuid, real, int);
drop function if exists public.gallery_match_face_v2(uuid, real, int);

-- Candidate people for one face, best first, scored by the mean distance to
-- their p_k nearest confirmed exemplars. Branches on the active recognizer:
-- euclidean over `embedding`, or cosine over `embedding_v2`.
--
-- Ask for p_limit >= 2 to get the runner-up the margin test needs.
create or replace function public.gallery_match_face(
  p_face_id      uuid,
  p_max_distance real default null,   -- null = the active recognizer's ceiling
  p_limit        int  default 5,
  p_k            int  default 3       -- 1 reproduces the old min() behaviour
)
returns table (person_id uuid, display_name text, distance real, exemplars bigint)
language plpgsql stable security definer set search_path = public
as $$
declare
  v_rec  text;
  v_max  real;
  v_k    int := greatest(coalesce(p_k, 3), 1);
begin
  select pr.recognizer, coalesce(p_max_distance, pr.ceiling)
    into v_rec, v_max
    from public.gallery_recognizer_params() pr;

  if v_rec = 'arcface' then
    return query
      with src as (
        select f.embedding_v2 as e
          from public.gallery_faces f
         where f.id = p_face_id and f.quality = 'ok' and f.embedding_v2 is not null
      ),
      scored as (
        select f.person_id as pid,
               (f.embedding_v2 <=> (select e from src)) as d,
               row_number() over (
                 partition by f.person_id
                 order by f.embedding_v2 <=> (select e from src)
               ) as rn
          from public.gallery_faces f
         where f.person_id is not null
           and f.quality = 'ok'
           and f.embedding_v2 is not null
           and f.id <> p_face_id
           and exists (select 1 from src)
           and not exists (
                 select 1 from public.gallery_face_rejections r
                  where r.face_id = p_face_id and r.person_id = f.person_id
               )
      )
      select s.pid,
             pe.display_name,
             (avg(s.d) filter (where s.rn <= v_k))::real,
             count(*)
        from scored s
        join public.gallery_people pe on pe.id = s.pid
       group by s.pid, pe.display_name
      having (avg(s.d) filter (where s.rn <= v_k))::real <= v_max
       order by 3 asc
       limit greatest(coalesce(p_limit, 5), 1);
  else
    return query
      with src as (
        select f.embedding as e
          from public.gallery_faces f
         where f.id = p_face_id and f.quality = 'ok'
      ),
      scored as (
        select f.person_id as pid,
               (f.embedding <-> (select e from src)) as d,
               row_number() over (
                 partition by f.person_id
                 order by f.embedding <-> (select e from src)
               ) as rn
          from public.gallery_faces f
         where f.person_id is not null
           and f.quality = 'ok'
           and f.id <> p_face_id
           and exists (select 1 from src)
           and not exists (
                 select 1 from public.gallery_face_rejections r
                  where r.face_id = p_face_id and r.person_id = f.person_id
               )
      )
      select s.pid,
             pe.display_name,
             (avg(s.d) filter (where s.rn <= v_k))::real,
             count(*)
        from scored s
        join public.gallery_people pe on pe.id = s.pid
       group by s.pid, pe.display_name
      having (avg(s.d) filter (where s.rn <= v_k))::real <= v_max
       order by 3 asc
       limit greatest(coalesce(p_limit, 5), 1);
  end if;
end $$;

comment on function public.gallery_match_face(uuid, real, int, int) is
  'Candidate people for one unnamed face, best first. Scored by the mean '
  'distance to the person''s p_k nearest confirmed exemplars, which is robust '
  'to a single bad confirm in a way min() is not. Reads the active recognizer '
  'from photo_gallery_config and branches between euclidean/embedding and '
  'cosine/embedding_v2. Low-quality faces are excluded on both sides.';

-- ---------------------------------------------------------------------------
-- 4. Writing suggestions — best candidate, but only if it wins clearly
-- ---------------------------------------------------------------------------
-- Shared by both re-suggest entry points. Returns true when a suggestion was
-- written, false when the face was left (or cleared) as unsuggested.
create or replace function public.gallery_apply_suggestion(
  p_face_id      uuid,
  p_max_distance real,
  p_min_margin   real,
  p_k            int,
  p_only_person  uuid default null    -- targeted mode: ignore other winners
)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare
  m      record;
  d1     real := null;
  d2     real := null;
  p1     uuid := null;
  wins   boolean;
begin
  for m in select * from public.gallery_match_face(p_face_id, p_max_distance, 2, p_k) loop
    if p1 is null then
      p1 := m.person_id; d1 := m.distance;
    else
      d2 := m.distance;
    end if;
  end loop;

  -- Clear wins outright, or beats the runner-up by at least the margin.
  wins := p1 is not null and (d2 is null or (d2 - d1) >= p_min_margin);

  if wins and (p_only_person is null or p1 = p_only_person) then
    update public.gallery_faces
       set suggested_person_id = p1, suggested_distance = d1
     where id = p_face_id;
    return true;
  end if;

  -- Targeted mode never clears a suggestion it did not make.
  if p_only_person is null then
    update public.gallery_faces
       set suggested_person_id = null, suggested_distance = null
     where id = p_face_id and suggested_person_id is not null;
  end if;
  return false;
end $$;

comment on function public.gallery_apply_suggestion(uuid, real, real, int, uuid) is
  'Writes at most one suggestion for a face. Requires the best candidate to '
  'beat the runner-up by p_min_margin — a near-tie means the machine cannot '
  'tell the two people apart, and an honest "Who is this?" beats a confident '
  'wrong guess that a human then confirms into the exemplar set.';

-- Full sweep over every unnamed, gated-in face.
drop function if exists public.gallery_resuggest(real);
drop function if exists public.gallery_resuggest_v2(real);

create or replace function public.gallery_resuggest(
  p_max_distance real default null,
  p_min_margin   real default null,
  p_k            int  default 3
) returns integer
language plpgsql security definer set search_path = public
as $$
declare
  n    integer := 0;
  f    record;
  v_max real;
  v_mar real;
begin
  select coalesce(p_max_distance, pr.ceiling), coalesce(p_min_margin, pr.margin)
    into v_max, v_mar
    from public.gallery_recognizer_params() pr;

  for f in select id from public.gallery_faces
            where person_id is null and quality = 'ok' loop
    if public.gallery_apply_suggestion(f.id, v_max, v_mar, p_k, null) then
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- Targeted sweep after a confirmation: only reconsiders faces that could newly
-- point at p_person_id, so it stays cheap enough to run on every confirm.
drop function if exists public.gallery_resuggest_for_person(uuid, real);
drop function if exists public.gallery_resuggest_for_person_v2(uuid, real);

create or replace function public.gallery_resuggest_for_person(
  p_person_id    uuid,
  p_max_distance real default null,
  p_min_margin   real default null,
  p_k            int  default 3
) returns integer
language plpgsql security definer set search_path = public
as $$
declare
  n    integer := 0;
  f    record;
  v_max real;
  v_mar real;
begin
  select coalesce(p_max_distance, pr.ceiling), coalesce(p_min_margin, pr.margin)
    into v_max, v_mar
    from public.gallery_recognizer_params() pr;

  for f in
    select gf.id from public.gallery_faces gf
     where gf.person_id is null
       and gf.quality = 'ok'
       and (gf.suggested_person_id is null or gf.suggested_distance > v_max)
  loop
    if public.gallery_apply_suggestion(f.id, v_max, v_mar, p_k, p_person_id) then
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Unreject, on the active recognizer
-- ---------------------------------------------------------------------------
-- The old version hardcoded the v1 euclidean matcher and a 0.55 default, so
-- under ArcFace it compared the wrong vectors against the wrong scale.
drop function if exists public.gallery_unreject_face(uuid, uuid, real);

create or replace function public.gallery_unreject_face(
  p_face_id      uuid,
  p_person_id    uuid,
  p_max_distance real default null,
  p_min_margin   real default null,
  p_k            int  default 3
) returns table (person_id uuid, display_name text, distance real)
language plpgsql security definer set search_path = public
as $$
declare
  v_max real;
  v_mar real;
begin
  select coalesce(p_max_distance, pr.ceiling), coalesce(p_min_margin, pr.margin)
    into v_max, v_mar
    from public.gallery_recognizer_params() pr;

  delete from public.gallery_face_rejections r
   where r.face_id = p_face_id and r.person_id = p_person_id;

  -- Only re-suggest for a face nobody has named; a confirmed face keeps its
  -- name. A gated-out face never gets a suggestion at all.
  if exists (select 1 from public.gallery_faces gf
              where gf.id = p_face_id
                and gf.person_id is null
                and gf.quality = 'ok') then
    if public.gallery_apply_suggestion(p_face_id, v_max, v_mar, p_k, null) then
      return query
        select gf.suggested_person_id, pe.display_name, gf.suggested_distance
          from public.gallery_faces gf
          join public.gallery_people pe on pe.id = gf.suggested_person_id
         where gf.id = p_face_id;
    end if;
  end if;
  return;
end $$;

comment on function public.gallery_unreject_face(uuid, uuid, real, real, int) is
  'Forgets a (face, person) rejection and recomputes the face''s suggestion on '
  'the ACTIVE recognizer. Returns no rows when nothing clears the ceiling and '
  'margin, so the caller can say "rejection undone, no new suggestion" rather '
  'than implying the old guess came back.';

-- ---------------------------------------------------------------------------
-- 6. Lock down the new and replaced functions
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER functions are auto-exposed as PostgREST RPC endpoints and
-- default to EXECUTE for PUBLIC. Every gallery mutation must go through the
-- photo-gallery edge function on the service role.
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
