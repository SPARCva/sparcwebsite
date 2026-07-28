-- Face recognition for the photo gallery ("tag a person once -> every photo of
-- them is tagged and searchable by name").
--
-- Faceprints are computed IN THE BROWSER by face-api.js (open-source, free) on
-- the admin page and stored here as 128-float descriptors. No image data is
-- duplicated and no photo/face data is ever sent to a third-party service.
-- Naming a face propagates the name to every face within a Euclidean-distance
-- threshold (done in the photo-gallery edge function), which also writes the
-- name into each matched photo's people[] so the public search finds them.

create table if not exists public.gallery_faces (
  id           uuid primary key default gen_random_uuid(),
  photo_id     uuid not null references public.gallery_photos(id) on delete cascade,
  embedding    jsonb not null,            -- 128 floats (face-api.js descriptor)
  box          jsonb,                     -- {x,y,width,height} in image px, for cropping the face
  person_name  text,                      -- null until named; naming matches by descriptor distance
  created_at   timestamptz not null default now()
);
create index if not exists gallery_faces_photo_idx  on public.gallery_faces (photo_id);
create index if not exists gallery_faces_person_idx on public.gallery_faces (person_name);

alter table public.gallery_faces enable row level security;
-- (no policies: service-role only, via the photo-gallery edge function)

comment on table public.gallery_faces is
  'Face descriptors for gallery photos (computed in-browser by face-api.js). Used to auto-propagate a person name to every matching photo. Service-role only; no face data leaves SPARC infrastructure.';

-- Marks a photo whose faces have already been computed, so re-scans are
-- incremental (a photo with zero faces is still marked scanned).
alter table public.gallery_photos add column if not exists face_scanned boolean not null default false;
