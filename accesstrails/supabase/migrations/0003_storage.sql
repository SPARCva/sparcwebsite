-- Access Trails NOVA — submission photo storage  (APPLIED)
-- Public-read bucket (mirrors the existing barrier-photos / report-photos
-- buckets) so the public Community Submissions page can display photos of
-- published entries. Anon may upload; staff manage.

insert into storage.buckets (id, name, public)
values ('access-trails-photos', 'access-trails-photos', true)
on conflict (id) do nothing;

create policy "anon upload trail photos" on storage.objects
  for insert to anon with check (bucket_id = 'access-trails-photos');

create policy "public read trail photos" on storage.objects
  for select to anon using (bucket_id = 'access-trails-photos');

create policy "staff manage trail photos" on storage.objects
  for all to authenticated
  using (bucket_id = 'access-trails-photos' and access_role() <> '')
  with check (bucket_id = 'access-trails-photos' and access_role() <> '');
