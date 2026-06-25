-- Optional seed data (mirrors the prototype mock content) so you can verify
-- the public page end-to-end. Safe to skip in production.
-- Run with: supabase db execute --file access/supabase/seed.sql
-- (or paste into the SQL editor). Photos have empty src so the page shows the
-- "photo to be added" placeholder until real images are uploaded via the console.

with l1 as (
  insert into public.locations (label, party, email, status, published, x, y)
  values ('Main plaza entrance', 'Reston Town Center Management', 'info@example.com', 'awaiting', true, 36, 42)
  returning id
)
insert into public.events (location_id, when_label, dir, txt, sort)
select id, 'Feb 15, 2026', 'Documented', 'Barrier photographed during a community accessibility walk.', 0 from l1
union all
select id, 'Mar 3, 2026', 'Sent to property manager', 'Letter describing the missing curb cut and requesting a remediation timeline.', 1 from l1
union all
select id, 'Mar 19, 2026', 'Received', 'Management acknowledged receipt; said the issue was under review by facilities.', 2 from l1;

-- A draft (published = false) — should NOT appear on the public page.
insert into public.locations (label, party, status, published, x, y)
values ('Fountain-side restaurant row', 'Individual tenant businesses', 'contacted', false, 66, 60);
