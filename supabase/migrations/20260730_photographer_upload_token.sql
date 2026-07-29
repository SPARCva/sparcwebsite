-- ---------------------------------------------------------------------------
-- Restore an upload-only "photographer" role.
--
-- Background: the v2 rewrite (20260729_gallery_people_and_faces_v2.sql) dropped
-- photo_gallery_config.photographer_token_sha256 and collapsed auth to a single
-- admin passphrase. That left /photogallery/upload/ — the page handed to event
-- photographers — requiring the FULL admin passphrase, so anyone given the link
-- could edit or delete the entire gallery. It also left upload-commit forcing
-- published = true, so a submission went straight to the public site with no
-- review step, which is the opposite of what that page promises.
--
-- This migration re-adds the column. The edge function resolves a token to a
-- role and restricts the photographer role to `categories`, `upload-urls` and
-- `upload-commit`, with published forced to false, so submissions land in the
-- admin review queue and nothing else is reachable.
--
-- Note it is NOT the v1 column returning: v1 kept a photographer role that
-- could also publish. This one cannot publish, cannot read the library, and
-- cannot delete.
-- ---------------------------------------------------------------------------

alter table public.photo_gallery_config
  add column if not exists photographer_token_sha256 text;

comment on column public.photo_gallery_config.photographer_token_sha256 is
  'SHA-256 (lowercase hex) of the upload-only photographer passphrase used at '
  '/photogallery/upload/. Restricted by the edge function to the categories, '
  'upload-urls and upload-commit actions, with published forced to false so '
  'submissions await admin review. NULL disables photographer uploads entirely.';

-- Set or rotate the passphrase (never store the plaintext):
--
--   printf '%s' 'YOUR-PHOTOGRAPHER-PASSPHRASE' | sha256sum
--
--   update public.photo_gallery_config
--   set photographer_token_sha256 = '<64-char-hex>', updated_at = now()
--   where id = true;
--
-- To revoke it, set the column back to null.

-- photo_gallery_config already has RLS enabled with no policies, so this column
-- is only ever readable by the service role from inside the edge function. No
-- grants are added here on purpose.
