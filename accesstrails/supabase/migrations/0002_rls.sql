-- Access Trails NOVA — Row Level Security  (APPLIED)
-- Reuses the shared access_role() helper (reads the access_staff roster), so
-- authorization matches the rest of the SPARC Access tooling.

alter table public.access_trails_submissions enable row level security;

-- anon: may only file a 'new' submission with no staff/publish fields set.
create policy "anyone can submit a trail review"
  on public.access_trails_submissions for insert to anon
  with check (status = 'new' and team_note is null and shown_publicly = false);

-- staff (on the access_staff roster) may read + triage everything.
create policy "staff manage trail submissions"
  on public.access_trails_submissions for all to authenticated
  using (access_role() <> '') with check (access_role() <> '');

grant insert on public.access_trails_submissions to anon;
grant select, insert, update, delete on public.access_trails_submissions to authenticated;
grant select on public.access_trails_public to anon, authenticated;

-- Roster management is handled by the EXISTING access_staff policies:
--   "admin manages roster"  (access_role() = 'admin')  -> INSERT/UPDATE/DELETE
--   "staff read roster"     (access_role() <> '')       -> SELECT
-- so any admin (e.g. andrew@sparcsolutions.org) can add/remove authorized
-- emails — including non-staff volunteers — from the Team Console.
