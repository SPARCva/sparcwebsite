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

## People search & face recognition

Search is a substring match over each photo's `people` tags plus its caption.
Tags get onto photos two ways:

1. **Manual** — typed in the admin (per-photo or bulk "Add people…").
2. **Face recognition** — the "People & faces" panel. Faceprints are computed
   **in the browser** by the open-source **face-api.js** (128-float
   descriptors), stored in `gallery_faces`. **No face data ever leaves SPARC
   infrastructure** — nothing is sent to AWS/Google/etc. Workflow: click
   **Scan photos for faces** (one-time per photo, incremental via
   `face_scanned`), then **name each person once** — naming propagates to every
   face within a Euclidean-distance threshold (default 0.55) and writes the name
   into each matched photo's `people[]`. Future photos: scan, name only the new
   faces. Face actions: `faces-status`, `faces-save`, `faces-unnamed`,
   `faces-for-photo`, `faces-name` (all admin-only). See
   `migrations/20260728_create_gallery_faces.sql`.

**Two ways to tag:** the "People & faces" panel lists all unnamed faces at once
(fastest for a big backfill), OR click any photo in the **Manage** grid to open
the per-photo **tag modal** — it shows every detected face (so you can tag
several people in one photo) plus a box for anyone whose face wasn't detected.
Either way, naming a face propagates to **every gallery** — tag someone in Gala
and they're tagged in Summit too. A photo is scanned on the fly the first time
you open its tag modal, so you can tag already-uploaded photos just by browsing.

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

### 2. Google Photos — Picker API (IMPLEMENTED)
Google retired broad Library/album read access in 2025; the supported path is
the **[Photos Picker API](https://developers.google.com/photos/picker/guides/get-started)**,
now wired into the admin page ("📷 Add from Google Photos").

Flow (`photogallery/admin/index.html`): Google Identity Services gets an OAuth
token for the `photospicker.mediaitems.readonly` scope → `POST /v1/sessions`
opens Google's picker → poll the session until `mediaItemsSet` → read
`/v1/mediaItems` → POST each `baseUrl` (`=w2000`) to `action:"import"` with
`source:"google_photos"`, the photo `id` as `external_id`, `createTime` as
`taken_at`, and the OAuth token as `auth`. The import action fetches each
photo server-side with that bearer token (never stored) and re-hosts it.

- **OAuth Client ID** (public, in the admin page): `GOOGLE_CLIENT_ID` constant.
  It's an OAuth *client id*, not a secret. Origins authorized:
  `https://sparcsolutions.org`, `https://www.sparcsolutions.org`.
- Requires the **Google Photos Picker API** enabled and an OAuth consent
  screen (Internal user type works for the Workspace org — no verification).
- Only works on the production origins above (not Netlify deploy previews),
  since the origin must be allow-listed on the OAuth client.
- Google does **not** expose the person names / face groups you set inside
  Google Photos — those cannot be imported. People search comes from our own
  tagging / face recognition.

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
