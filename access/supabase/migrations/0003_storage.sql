-- Storage bucket for barrier photos: public read, staff write.
--
-- The bucket itself is created in the dashboard or via the CLI/API:
--   insert into storage.buckets (id, name, public)
--   values ('barrier-photos', 'barrier-photos', true)
--   on conflict (id) do nothing;
-- (Public read is also enforced by the policy below; `public = true` lets
--  getPublicUrl() return a directly servable URL.)

insert into storage.buckets (id, name, public)
values ('barrier-photos', 'barrier-photos', true)
on conflict (id) do nothing;

-- anon may only read; authenticated staff may upload/delete.
create policy "anon read barrier photos" on storage.objects
  for select to anon using (bucket_id = 'barrier-photos');

create policy "staff write barrier photos" on storage.objects
  for all to authenticated
  using (bucket_id = 'barrier-photos') with check (bucket_id = 'barrier-photos');
