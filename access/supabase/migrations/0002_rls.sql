-- Row Level Security — this is what enforces the Draft/Published review gate.
-- Unpublished barriers are invisible to the anon (public) key at the DB layer,
-- even if a UI bug tried to request them.

alter table public.locations enable row level security;
alter table public.photos    enable row level security;
alter table public.events    enable row level security;

-- PUBLIC (anon) may read ONLY published locations and their children.
create policy "anon reads published locations"
  on public.locations for select
  to anon
  using (published = true);

create policy "anon reads photos of published locations"
  on public.photos for select
  to anon
  using (exists (select 1 from public.locations l
                 where l.id = photos.location_id and l.published));

create policy "anon reads events of published locations"
  on public.events for select
  to anon
  using (exists (select 1 from public.locations l
                 where l.id = events.location_id and l.published));

-- AUTHENTICATED staff may do everything (read drafts, write, delete).
create policy "staff full access locations" on public.locations
  for all to authenticated using (true) with check (true);
create policy "staff full access photos" on public.photos
  for all to authenticated using (true) with check (true);
create policy "staff full access events" on public.events
  for all to authenticated using (true) with check (true);

-- NOTE (staff allow-list): the policies above grant full access to ANY
-- authenticated user. For launch, control who can sign in by only inviting
-- known staff emails (magic links are not sent to uninvited addresses).
-- To harden later, replace `to authenticated using (true)` with a check
-- against a `staff_emails` table, e.g.:
--
--   create table public.staff_emails (email text primary key);
--   create policy "staff full access locations" on public.locations
--     for all to authenticated
--     using  (exists (select 1 from public.staff_emails s where s.email = auth.jwt()->>'email'))
--     with check (exists (select 1 from public.staff_emails s where s.email = auth.jwt()->>'email'));
--
-- The final allow-list is a SPARC-team decision (see README §"Open items").
