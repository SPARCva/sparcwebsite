# photo-gallery

Backend for the public photo gallery at **`/photogallery`** — three albums
(`gala`, `summit`, `life`), each with a year selector, person/caption search,
and a header "scroll" of featured photos kept in chronological order.

- **Project:** `ldxpockcgcxvsrbyhcnt` (SPARC Website And Accessibility Project)
- **Endpoint:** `https://ldxpockcgcxvsrbyhcnt.supabase.co/functions/v1/photo-gallery`
- **Storage bucket:** `gallery` (public read; writes only via this function)
- **Tables:** `gallery_photos`, `photo_gallery_config` (both RLS-locked, no
  policies → service-role only, matching the site's other backends)

## Pages

| URL | What it is |
| --- | --- |
| `/photogallery/` | Landing page with the three album cards (live cover images) |
| `/photogallery/gala/` · `/summit/` · `/life/` | Public gallery for one album |
| `/photogallery/admin/` | Admin-passphrase upload / tagging / management tool (`noindex`) |
| `/photogallery/upload/` | Photographer batch-upload page (`noindex`); uploads land unpublished for admin review |

Client code: `js/photo-gallery.js` (public), `css/photo-gallery.css`, and the
inline script in `photogallery/admin/index.html`.

## Actions

### Public (GET — no auth beyond the Supabase gateway apikey)

```
GET ?action=list&gallery=gala[&year=2025|all][&q=jane]
-> { ok, years:[2025,…], selectedYear, featured:[…], photos:[…], count }
```

Only `published = true` rows are ever returned. `q` matches (case-insensitive
substring) against the caption and any person tag. `featured` are the header-
scroll photos, ordered by `featured_order` → `taken_at` → `created_at`.

### Admin (POST — require the `x-admin-token` header)

The header value is hashed (SHA-256) and compared to
`photo_gallery_config.admin_token_sha256`. Requests without a matching token
get `401`.

| Payload | Behavior |
| --- | --- |
| multipart `action=upload` + `file` + `gallery,year,caption,alt_text,people,taken_at,is_featured` | Stores the image in the bucket at `gallery/<album>/<year>/<uuid>.<ext>` and inserts a row. |
| `{ action:"import", gallery, year, source, items:[{image_url, external_id?, caption?, people?, taken_at?}] }` | Downloads each image and **re-hosts it in the bucket** (so expiring share URLs never break), then inserts rows. De-dupes on `(source, external_id)`. ≤200 per call. |
| `{ action:"list-admin", gallery? }` | All rows incl. unpublished, for the management grid. |
| `{ action:"update", id, patch:{…} }` | Edits one row (caption, alt_text, people, year, gallery, is_featured, featured_order, sort_order, taken_at, published). |
| `{ action:"bulk-update", ids:[…], patch:{…} }` | Same fields across many rows. `patch.add_people` **appends** tags without clobbering existing ones. |
| `{ action:"delete", id }` | Deletes the row and its storage object. |

## People search & privacy

Person tags in `people` are **manually assigned** in the admin tool. No face
recognition and **no biometric/face data is ever computed or stored** — an
intentional choice given that many SPARC constituents are adults with
disabilities and cannot be assumed to have consented to biometric processing.
Search is a plain substring match over those hand-entered names plus captions.

## Setting the admin passphrase (one-time)

The passphrase is stored only as a SHA-256 hash. To set or rotate it:

```sql
-- compute the hash of your chosen passphrase, e.g.:
--   printf '%s' 'YOUR-PASSPHRASE' | sha256sum
update public.photo_gallery_config
set admin_token_sha256 = '<64-char-hex>', updated_at = now()
where id = true;
```

Then sign in at `/photogallery/admin/` with the plaintext passphrase. Until a
hash is set, all writes are denied.

## Two roles

| Role | Column | Can do | Where |
| --- | --- | --- | --- |
| **Admin** | `admin_token_sha256` | Everything: upload (publishes immediately), import, edit/tag, feature, publish/hide, delete | `/photogallery/admin/` |
| **Photographer** | `photographer_token_sha256` | Batch-upload only; photos land **unpublished** (`source = 'photographer'`) for admin review | `/photogallery/upload/` |

Set the photographer passphrase the same way as the admin one, hashing into
`photographer_token_sha256`. Photographer uploads appear dimmed in the admin
grid with a **Show** button — that's the review queue: the admin approves
(publishes) or deletes each batch.

## Importing from other sources — "make it easy"

The `import` action already re-hosts any batch of image URLs. The pieces below
turn each external source into a one-click flow. Each needs a small amount of
one-time credential setup, noted inline.

### 1. Import by link (works today)
In the admin **Import** panel, paste public image URLs (one per line) and pick
a source label. Good for Google Photos share-link images or any public URL.

### 2. Google Photos — Picker API (recommended)
Google retired broad Library/album read access in 2025; the supported path is
the **[Photos Picker API](https://developers.google.com/photos/picker/guides/get-started)**:
the user opens a Google-hosted picker, selects photos (from *any* album,
including "shared with me"), and the app receives temporary `baseUrl`s.
Setup: create an OAuth client (Google Cloud console) for `sparcsolutions.org`,
enable the Photos Picker API, add a "Pick from Google Photos" button to the
admin page that opens the picker, then POST the chosen `baseUrl`s (append
`=d` for full-res) to `action:"import"` with `source:"google_photos"` and each
photo's `id` as `external_id`. Because import re-hosts immediately, the
short-lived picker URLs don't matter.

### 3. Google Drive — Picker API
For photos already in Google Drive, use the
**[Google Picker API](https://developers.google.com/drive/picker/guides/overview)**.
Same shape as above: pick files → get temporary download links → POST to
`action:"import"` with `source:"gdrive"`. **Fastest path right now:** Claude
has authenticated Drive access in the working session and can bulk-import a
whole shared Drive folder on request — just share the folder and say which
album/year.

### 4. OneDrive "Summit Photos" folder
Use the **[OneDrive File Picker v8](https://learn.microsoft.com/en-us/onedrive/developer/controls/file-pickers/)**
(register an app in Entra ID / Azure) to let the user pick from the
"Summit Photos" folder, or run a scheduled Microsoft Graph sync
(`/me/drive/root:/Summit Photos:/children`) that POSTs new items to
`action:"import"` with `source:"onedrive"`, `gallery:"summit"`. Store the app
credentials in `photo_gallery_config` (add columns) or Supabase secrets.

### 5. Facebook Page albums
For SPARC's Facebook **Page** (not personal profiles), a long-lived Page token
can read album photos via the Graph API
(`/{page-id}/albums` → `/{album-id}/photos`). `photo_gallery_config` already
has `facebook_page_id` / `facebook_page_token` columns; a scheduled function
can page through new photos and POST them to `action:"import"` with
`source:"facebook"`. Requires a reviewed Facebook app with
`pages_read_engagement`.

### Suggested automation (cron)
A single scheduled edge function (or Supabase cron) can, per configured source,
pull "new since last run" and call `import` — giving hands-off syncing once any
of the above credentials are in place. Keep a per-source cursor (last synced
timestamp / token) in `photo_gallery_config`.
