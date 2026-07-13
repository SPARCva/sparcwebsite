-- Access Trails NOVA — Contribute form schema  (PROPOSED — NOT YET APPLIED)
-- One row per public "Contribute a Park Review" submission. Reviewed and
-- triaged by SPARC staff; nothing here is shown publicly.
--
-- Review the DDL, then apply via the Supabase CLI (supabase db push) or the
-- dashboard SQL editor, in order: 0001 -> 0002 -> 0003.

create table if not exists public.access_trails_submissions (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),

  -- "I found a(n):"
  find_type      text not null
                 check (find_type in (
                   'ADA Accessible Park',
                   'ADA Accessible Park Feature',
                   'Park that needs an ADA Feature')),

  park_name      text not null,               -- park name and city
  description    text not null,               -- feature / suggestion

  may_contact    boolean not null,            -- may we follow up?
  first_name     text,                        -- optional
  last_name      text,                        -- optional
  contact_method text not null,               -- Email / Phone call / Text message
  contact_detail text,                        -- email or phone (free text)

  photo_path     text,                        -- object path in the storage bucket, if any

  -- staff triage
  status         text not null default 'new'
                 check (status in ('new','reviewed','published','archived','spam')),

  -- light server-side guards
  constraint park_name_len    check (char_length(park_name) between 1 and 200),
  constraint description_len  check (char_length(description) between 1 and 5000)
);

create index if not exists access_trails_submissions_created_at_idx
  on public.access_trails_submissions (created_at desc);
create index if not exists access_trails_submissions_status_idx
  on public.access_trails_submissions (status);
