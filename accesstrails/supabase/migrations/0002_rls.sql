-- Access Trails NOVA — Row Level Security  (PROPOSED — NOT YET APPLIED)
-- The public form is anonymous. The anon role may ONLY INSERT — it can never
-- read, update, or delete submissions. Staff read/triage through the Supabase
-- dashboard (service role) or an authenticated internal tool.

alter table public.access_trails_submissions enable row level security;

-- anon: INSERT only. No select/update/delete policy for anon => those are denied.
create policy "anon can submit a review"
  on public.access_trails_submissions
  for insert
  to anon
  with check (
    -- accept only the constrained shape; status must start as 'new'
    status = 'new'
    and char_length(park_name) between 1 and 200
    and char_length(description) between 1 and 5000
  );

-- authenticated staff may read + triage everything.
create policy "staff read submissions"
  on public.access_trails_submissions for select to authenticated using (true);
create policy "staff update submissions"
  on public.access_trails_submissions for update to authenticated using (true) with check (true);
create policy "staff delete submissions"
  on public.access_trails_submissions for delete to authenticated using (true);

-- OPTIONAL server-side rate limit (defense in depth on top of the client-side
-- 30s throttle and honeypot). Uncomment to cap anonymous inserts per IP/minute.
-- Requires the request IP, exposed via a header; adjust to your setup.
--
-- create or replace function public.access_trails_rate_guard()
-- returns trigger language plpgsql as $$
-- begin
--   if (select count(*) from public.access_trails_submissions
--        where created_at > now() - interval '1 minute') > 20 then
--     raise exception 'Too many submissions, please try again shortly.';
--   end if;
--   return new;
-- end $$;
-- create trigger access_trails_rate_guard_trg
--   before insert on public.access_trails_submissions
--   for each row execute function public.access_trails_rate_guard();
