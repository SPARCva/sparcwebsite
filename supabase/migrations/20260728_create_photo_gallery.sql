-- Photo Gallery backend for the public /photogallery pages.
-- ---------------------------------------------------------------------------
-- Three galleries: 'gala' (An Evening to SPARCle), 'summit' (A Call to
-- Conscience), and 'life' (everyday life at SPARC). Photos are hosted in the
-- public `gallery` storage bucket; all metadata lives in public.gallery_photos.
--
-- Access model (matches the site's other backends): the table is RLS-enabled
-- with NO policies, so nothing but the service role can touch it. Every read
-- and write goes through the `photo-gallery` edge function. Public reads return
-- only rows where published = true. The storage bucket is public-read so the
-- browser can load <img src> directly, but writes are service-role only.

-- ---- storage bucket --------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('gallery', 'gallery', true)
on conflict (id) do update set public = true;

-- ---- photos ----------------------------------------------------------------
create table if not exists public.gallery_photos (
  id             uuid primary key default gen_random_uuid(),
  gallery        text not null check (gallery in ('gala', 'summit', 'life')),
  year           int  not null check (year between 1990 and 2100),
  storage_path   text,                      -- path within the `gallery` bucket (null only for pure external links)
  image_url      text not null,             -- public URL used by <img src>
  thumb_url      text,                       -- optional smaller preview URL (falls back to image_url)
  caption        text not null default '',
  alt_text       text not null default '',   -- accessibility: explicit alt (falls back to caption)
  people         text[] not null default '{}', -- searchable person-name tags
  taken_at       timestamptz,                -- capture time; orders photos "through the day"
  is_featured    boolean not null default false, -- appears in the header photo scroll
  featured_order int,                         -- manual position within the header scroll (nulls sort last)
  sort_order     int not null default 0,      -- manual position within the grid
  source         text not null default 'upload'
                   check (source in ('upload', 'google_photos', 'gdrive', 'onedrive', 'facebook', 'repo')),
  external_id    text,                        -- de-dupe key for imported photos (e.g. Google Photos media id)
  width          int,
  height         int,
  published      boolean not null default true,
  created_at     timestamptz not null default now()
);

create index if not exists gallery_photos_gallery_year_idx
  on public.gallery_photos (gallery, year);
create index if not exists gallery_photos_people_idx
  on public.gallery_photos using gin (people);
create index if not exists gallery_photos_taken_at_idx
  on public.gallery_photos (taken_at);
create unique index if not exists gallery_photos_source_external_idx
  on public.gallery_photos (source, external_id) where external_id is not null;

alter table public.gallery_photos enable row level security;
-- (no policies: service-role only, via the photo-gallery edge function)

comment on table public.gallery_photos is
  'Photos for the public /photogallery (galleries: gala, summit, life). Read and written only by the photo-gallery edge function (service role); RLS blocks all anon/public access. Public reads return published rows only. `people` holds manually-assigned person-name tags used for search; no biometric/face data is ever stored.';

-- ---- config (admin passphrase + optional import credentials) ---------------
-- Single row, RLS enabled with no policies -> service-role only. The admin
-- passphrase is stored ONLY as a SHA-256 hash; the plaintext is never
-- committed and is set with a one-off UPDATE after deploy.
create table if not exists public.photo_gallery_config (
  id                  boolean primary key default true check (id),
  admin_token_sha256  text,        -- sha-256 hex of the admin passphrase
  facebook_page_id    text,        -- optional: Facebook Page whose albums we import
  facebook_page_token text,        -- optional: long-lived Page access token
  updated_at          timestamptz not null default now()
);

insert into public.photo_gallery_config (id) values (true)
  on conflict (id) do nothing;

alter table public.photo_gallery_config enable row level security;
-- (no policies: service-role only)
