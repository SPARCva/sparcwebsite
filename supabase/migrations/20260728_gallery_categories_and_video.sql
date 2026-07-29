-- Gallery categories (dynamic albums) + submission label + embedded-video support.
-- Categories with is_public = true are served on the public site (gala/summit/life);
-- custom categories default to admin-only.

create table if not exists public.gallery_categories (
  slug text primary key,
  name text not null,
  is_public boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
alter table public.gallery_categories enable row level security;
-- No policies: service-role access only, from the photo-gallery edge function.

insert into public.gallery_categories (slug, name, is_public, sort_order) values
  ('gala','Annual Gala', true, 1),
  ('summit','Summit', true, 2),
  ('life','Life at SPARC', true, 3)
on conflict (slug) do nothing;

-- Optional batch/album label set by the uploader (esp. photographer submissions),
-- used to group the admin review queue.
alter table public.gallery_photos add column if not exists submission text;

-- Embedded video support: media_type = 'photo' | 'video'. Videos are embedded
-- (youtube/vimeo) with image_url holding the thumbnail and video_url the embed URL.
alter table public.gallery_photos
  add column if not exists media_type text not null default 'photo',
  add column if not exists video_url text,
  add column if not exists video_provider text;

comment on table public.gallery_categories is 'Gallery categories/albums. is_public=true are served on the public site (gala/summit/life); custom ones default to admin-only.';
comment on column public.gallery_photos.submission is 'Optional batch/album label set by the uploader (esp. photographer submissions), used to group the admin review queue.';
comment on column public.gallery_photos.media_type is 'photo | video. Videos are embedded (youtube/vimeo) with image_url holding the thumbnail.';
