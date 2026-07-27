-- Volunteer applications submitted through the SPARC website.
-- Applied to project ldxpockcgcxvsrbyhcnt.
create table if not exists public.volunteer_applications (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text not null,
  email text not null,
  phone text,
  interests text[] not null default '{}',   -- selected volunteer areas
  availability text,                         -- free text (e.g. "weekday mornings")
  message text,                              -- optional note from the applicant
  source text,
  user_agent text,
  confirmation_sent boolean not null default false,
  notification_sent boolean not null default false,
  send_error text
);

comment on table public.volunteer_applications is
  'Volunteer applications captured via the /volunteer page. Written only by the volunteer-register edge function (service role); RLS blocks all anon/public access.';

alter table public.volunteer_applications enable row level security;
-- No policies are defined on purpose: the anon/public role has no access.
-- The edge function uses the service-role key, which bypasses RLS.

create index if not exists idx_volunteer_created_at
  on public.volunteer_applications (created_at desc);
create index if not exists idx_volunteer_email
  on public.volunteer_applications (lower(email));
