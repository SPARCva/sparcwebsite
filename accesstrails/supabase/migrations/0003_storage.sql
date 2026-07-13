-- Access Trails NOVA — submission photo storage  (PROPOSED — NOT YET APPLIED)
-- Private bucket for photos attached to a Contribute submission. Anonymous
-- users may UPLOAD only; they cannot list or read the bucket. Staff (service
-- role / authenticated) read photos during triage.

insert into storage.buckets (id, name, public)
values ('access-trails-submissions', 'access-trails-submissions', false)
on conflict (id) do nothing;

-- anon: INSERT (upload) only — no select/update/delete for anon.
create policy "anon upload submission photo"
  on storage.objects for insert to anon
  with check (bucket_id = 'access-trails-submissions');

-- authenticated staff: full access to triage/clean up.
create policy "staff manage submission photos"
  on storage.objects for all to authenticated
  using (bucket_id = 'access-trails-submissions')
  with check (bucket_id = 'access-trails-submissions');

-- NOTE: bucket is PRIVATE (public = false). Staff view photos via signed URLs
-- created with the service role, so uploaded images are never publicly listable.
