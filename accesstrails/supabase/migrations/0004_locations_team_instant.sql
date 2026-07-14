-- Access Trails NOVA v2 — functional parity with /ART  (APPLIED 2026-07)
--
-- 1. LOCATION SCOPING — every submission can be tied to a SPARC center area
--    (location_slug), a specific park (park_slug), and the park amenity it
--    describes (feature_type), so each geographic page can show and collect
--    accessibility detail in place.
-- 2. TEAM NOTES — staff post from the Team Console or directly on any park
--    page (source='team', submitted_by=staff email). The public only ever
--    sees the 'SPARC Team' label, never the email (the view hides it).
-- 3. INSTANT DISPLAY — mirrors /ART v2.4 ("instant, unmoderated community
--    display"): submissions appear on the public pages immediately via the
--    access_trails_community view. Staff Archive / Spam are the removal
--    levers; nothing personal is ever exposed.
--
-- Safe to re-run.

alter table public.access_trails_submissions
  add column if not exists location_slug text
    check (location_slug in ('alexandria','arlington','leesburg','mclean')),
  add column if not exists park_slug text
    check (char_length(park_slug) <= 80),
  add column if not exists feature_type text
    check (feature_type in ('parking','dropoff','paths','trails','bathrooms',
                            'picnic_seating','visitors_center','playground',
                            'water_features','signage','sensory','other')),
  add column if not exists source text not null default 'public'
    check (source in ('public','team')),
  add column if not exists submitted_by text
    check (char_length(submitted_by) <= 200);

create index if not exists access_trails_submissions_loc_idx
  on public.access_trails_submissions (location_slug, park_slug);

-- Public read path: instant-display view with only the safe columns.
-- (security_invoker = off => the view itself is the boundary, same pattern as
--  the /ART access_community_board view. The base table stays insert-only for
--  anon; reporter names/contact details and team emails are never selected.)
create or replace view public.access_trails_community
with (security_invoker = off) as
  select id, find_type, feature_type, park_name, description, photo_paths,
         location_slug, park_slug, source, status, created_at
  from public.access_trails_submissions
  where status not in ('archived','spam');

grant select on public.access_trails_community to anon, authenticated;

comment on view public.access_trails_community is
  'Instant-display Access Trails notes (mirrors /ART community board). Excludes reporter identity, contact info, staff emails, and team notes by design; staff hide a row by setting status=archived or spam.';

-- Anon may only file a plain public submission — never a team-attributed one.
drop policy if exists "anyone can submit a trail review" on public.access_trails_submissions;
create policy "anyone can submit a trail review"
  on public.access_trails_submissions for insert to anon
  with check (status = 'new' and team_note is null and shown_publicly = false
              and source = 'public' and submitted_by is null);

-- Signed-in visitors who are NOT on the staff roster get the same insert
-- shape as anon (the staff FOR ALL policy already covers roster members).
drop policy if exists "signed-in visitors submit as public" on public.access_trails_submissions;
create policy "signed-in visitors submit as public"
  on public.access_trails_submissions for insert to authenticated
  with check (status = 'new' and team_note is null and shown_publicly = false
              and source = 'public' and submitted_by is null);
