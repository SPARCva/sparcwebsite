-- Access Trails NOVA — Contribute form schema  (APPLIED 2026-07 to project
-- ldxpockcgcxvsrbyhcnt). Mirrors the established access_public_reports pattern:
-- anon files a 'new' submission; SPARC staff triage; shown_publicly gates the
-- public Community Submissions page.

create table if not exists public.access_trails_submissions (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  status         text not null default 'new'
                 check (status in ('new','reviewed','archived','spam')),
  find_type      text check (find_type in (
                   'ADA Accessible Park',
                   'ADA Accessible Park Feature',
                   'Park that needs an ADA Feature')),
  park_name      text not null,
  description    text not null,
  may_contact    boolean not null default false,
  reporter_first text,
  reporter_last  text,
  contact_method text,
  contact_detail text,
  team_note      text,                        -- staff only
  shown_publicly boolean not null default false,
  shown_at       timestamptz,
  photo_paths    text[],                      -- paths in the access-trails-photos bucket
  constraint park_name_len   check (char_length(park_name) between 1 and 200),
  constraint description_len check (char_length(description) between 1 and 5000)
);
create index if not exists access_trails_submissions_created_idx
  on public.access_trails_submissions (created_at desc);
create index if not exists access_trails_submissions_shown_idx
  on public.access_trails_submissions (shown_publicly) where shown_publicly;

-- PII-safe public view: only staff-published rows, only non-personal columns.
-- (SECURITY DEFINER so anon can read published rows without a table SELECT
--  grant — same pattern as the existing access_community_board view.)
create or replace view public.access_trails_public as
  select id, find_type, park_name, description, photo_paths, created_at, shown_at
  from public.access_trails_submissions
  where shown_publicly = true;
