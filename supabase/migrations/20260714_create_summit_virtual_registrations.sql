-- Free virtual registrations for the SPARC "A Call to Conscience" summit.
-- Applied to project ldxpockcgcxvsrbyhcnt.
create table if not exists public.summit_virtual_registrations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text not null,
  email text not null,
  source text,
  user_agent text,
  confirmation_sent boolean not null default false,
  notification_sent boolean not null default false,
  send_error text
);

comment on table public.summit_virtual_registrations is
  'Free virtual registrations for the SPARC "A Call to Conscience" summit. Captured via the /virtualsummit page and the "Join Virtually for Free" modal on /summit. Written only by the virtual-summit-register edge function (service role); RLS blocks all anon/public access.';

alter table public.summit_virtual_registrations enable row level security;
-- No policies are defined on purpose: the anon/public role has no access.
-- The edge function uses the service-role key, which bypasses RLS.

create index if not exists idx_svr_created_at
  on public.summit_virtual_registrations (created_at desc);
create index if not exists idx_svr_email
  on public.summit_virtual_registrations (lower(email));
