# photo-gallery

Backend for the public photo gallery at **`/photogallery`** — three albums
(`gala`, `summit`, `life`), each with a year selector, person/caption search,
and a header "scroll" of featured photos kept in chronological order.

- **Project:** `ldxpockcgcxvsrbyhcnt` (SPARC Website And Accessibility Project)
- **Endpoint:** `https://ldxpockcgcxvsrbyhcnt.supabase.co/functions/v1/photo-gallery`
- **Storage bucket:** `gallery` (public read; writes only via this function)
- **Schema:** `migrations/20260729_gallery_people_and_faces_v2.sql` (people
  roster + face recognition v2) and `migrations/20260729_gallery_resuggest_and_search.sql`
  (the `gallery_list_photos` search helper and `gallery_resuggest_for_person`).
  All gallery tables are RLS-locked with no policies → service-role only, and
  the `gallery_*` RPCs are granted to `service_role` only.

## Pages

| URL | What it is |
| --- | --- |
| `/photogallery/` | Landing page with the three album cards (live cover images) |
| `/photogallery/gala/` · `/summit/` · `/life/` | Public gallery for one album |
| `/photogallery/admin/` | Admin-passphrase upload / tagging / management tool (`noindex`) |

Client code: `js/photo-gallery.js` (public), `css/photo-gallery.css`, and the
inline script in `photogallery/admin/index.html`.

## Auth

There is **one role**. Every write is a `POST` with an `x-admin-token` header;
the value is hashed (SHA-256) and compared, in constant time, against
`photo_gallery_config.admin_token_sha256`. Anything else gets a `401` — after a
~300 ms delay to blunt brute-forcing. There is deliberately **no lockout**: a
single shared passphrase with a lockout would be a self-inflicted denial of
service. Postgres error text is never returned to the client (it leaks schema);
errors are logged server-side and a generic message is returned.

## Public read (GET — only the Supabase gateway apikey)

```
GET ?action=list&gallery=gala[&year=2025|all][&q=jane]
-> { ok, gallery, name, years:[2025,…], selectedYear, featured:[…], photos:[…], count }
```

Only `published = true` rows in a category with `is_public = true` are ever
returned. `q` is a case-insensitive **substring** match against the caption and
any person tag, run **in SQL** (the `gallery_list_photos` helper: `caption ILIKE`
plus an `unnest(people) ILIKE`), not by fetching everything and filtering in JS.
`photos` are ordered `taken_at → sort_order → created_at` and capped at 2000.
`featured` are the header-scroll photos, ordered by `featured_order → taken_at →
created_at`. Each row carries `width`, `height`, and `thumb_url` so the front
end can reserve layout space.

## Admin actions (POST + `x-admin-token`)

### Uploads — signed direct-to-storage

The function never touches image bytes on upload. The browser resizes to
≤2000 px, makes a 400 px JPEG thumbnail, and PUTs both straight to storage
against signed URLs.

| Payload | Behavior |
| --- | --- |
| `{ action:"upload-urls", gallery, year, files:[{name, content_type}] }` | Returns `{ ok, uploads:[{ index, main:{path,token,signedUrl}, thumb:{path,token,signedUrl} }] }`. Main object at `<gallery>/<year>/<uuid>.<ext>`, thumb at `<gallery>/<year>/thumbs/<uuid>.jpg`. ≤50 files per call. |
| `{ action:"upload-commit", gallery, year, items:[{storage_path, thumb_path, caption?, alt_text?, taken_at?, width?, height?, is_featured?, source?}] }` | Inserts rows for objects that were actually PUT. **Each `storage_path` is verified to exist in the bucket first**, so a failed browser PUT can't create an orphan row. Resolves `image_url`/`thumb_url` via `getPublicUrl`, sets `needs_alt` when neither alt nor caption is present. Does **not** accept a `people` field. Returns `{ ok, inserted, ids, skipped }`. |

### Import (re-host external images)

```
{ action:"import", gallery, year, source, items:[{image_url, external_id?, caption?, alt_text?, taken_at?, width?, height?}], auth? }
```

Downloads each image and **re-hosts it in the bucket** (so expiring share URLs
never break), then inserts rows. De-dupes on `(source, external_id)`. ≤200 per
call, ≤25 MB per image. `thumb_path` is left `null` for imports — a later
backfill renders their 400 px thumbnails. Sets `needs_alt` unless a caption or
alt was supplied.

**SSRF allowlist:** `import` only fetches `https:` URLs whose host is (a suffix
of) `googleusercontent.com`, `googleapis.com`, `photoslibrary.googleapis.com`,
`drive.google.com`, `dropboxusercontent.com`, or `dropbox.com`; anything else,
and any private-range / localhost literal, is rejected. Without this the
function would be an open fetch proxy.

### Manage

| Payload | Behavior |
| --- | --- |
| `{ action:"list-admin", gallery?, year?, filter?, limit?, offset? }` | Paginated management grid. `limit` default 100 / max 500, `offset` default 0. `filter` ∈ `needs_alt` / `unscanned` (`face_scanned=false`) / `untagged` (no `gallery_photo_people` rows) / `unpublished`. Returns `{ ok, photos, total }` (`total` is an exact head count for paging). |
| `{ action:"update", id, patch }` | Edits one row: `caption, alt_text, year, gallery, is_featured, featured_order, sort_order, taken_at, published, submission`. Recomputes `needs_alt` when caption/alt change. |
| `{ action:"bulk-update", ids, patch }` | Same fields across ≤1000 rows; recomputes `needs_alt` for the batch. Approving a review batch is `patch:{published:true}`. |
| `{ action:"delete", id }` | Deletes the row **and both** its storage objects (`storage_path` + `thumb_path`). |
| `{ action:"video-add", gallery, year, video_url, caption?, alt_text?, taken_at?, is_featured?, submission? }` | Adds an embedded YouTube/Vimeo video (`media_type='video'`, embed URL in `video_url`, thumbnail in `image_url`). |
| `{ action:"categories" }` / `{ action:"category-create", name, slug?, is_public? }` | List / create categories. New categories default to `is_public:false` (not served publicly). |

**`people[]` is never written by an `update`/`bulk-update` patch.** It is a
denormalised **cache**, maintained by a trigger from `gallery_photo_people`
(excluding people flagged `hidden`). Sending `people` or `add_people` in a patch
is silently ignored. To tag a photo, use `photo-tag` / face confirmation below;
the trigger rebuilds `people[]`.

## People roster & face recognition

Faces are detected **in the browser** by the open-source **face-api.js** (128-float
descriptors); the descriptors are stored in `gallery_faces` as `vector(128)` and
**never leave SPARC infrastructure**. Matching runs inside Postgres (the
`gallery_match_face` / `gallery_resuggest*` RPCs), not in JavaScript.

### Suggest → confirm/reject (this is the important part)

Naming a face **does not** write a name across the database. A confirmed face
is an *exemplar* for a person; unnamed faces get a **suggestion** (nearest
exemplar under a distance threshold) that a human then **confirms** or
**rejects**:

- **Confirm** adds the face to that person's exemplar set, so recognition
  improves with use, and links the photo to the person (via
  `gallery_photo_people`, which refreshes `people[]`).
- **Reject** is remembered per `(face, person)`, so a wrong guess is never
  suggested again — even after a re-suggest sweep.

Nothing is auto-applied; `people[]` on a photo stays empty until a face on it is
confirmed (or the photo is tagged manually).

| Payload | Behavior |
| --- | --- |
| `{ action:"people-list", q?, limit?, offset? }` | Roster with `photo_count`, `face_count`, and a `cover` (one confirmed face → `{photo_id, image_url, box}`). `q` substring-matches `display_name` + `aliases`. Ordered by `sort_name → display_name`. |
| `{ action:"person-create", display_name, kind?, sort_name?, aliases? }` | Creates a person. On the unique-name conflict, returns `409` with `existing_id`. |
| `{ action:"person-update", id, patch }` | Edits `display_name, sort_name, aliases, kind, hidden, notes`. Renames and `hidden` changes propagate to every photo via trigger. |
| `{ action:"person-merge", keep_id, drop_id }` | Merges duplicates (`gallery_merge_people`); returns the resulting photo count. |
| `{ action:"person-delete", id }` | Deletes the person; their faces fall back to unnamed. Returns how many faces were orphaned. |
| `{ action:"faces-save", photo_id, faces:[{embedding[128], box:{x,y,w,h}, det_score?, detector?}] }` | Stores detector output for a photo (≤100). Boxes are **fractions of the image (0..1)**. Replaces prior `detected` faces but preserves `manual` ones; **skips photos that already have confirmed faces**; marks `face_scanned=true` even with zero faces. |
| `{ action:"faces-for-photo", photo_id }` | `{ ok, scanned, faces:[{id, box, origin, person|null, suggestion|null}] }`. |
| `{ action:"face-add-manual", photo_id, box, embedding, person_id? }` | Hand-drawn face the detector missed (`origin='manual'`). With `person_id`, confirms it immediately so it becomes an exemplar. |
| `{ action:"face-confirm", face_id, person_id? \| new_person_name? }` | Confirms a face. With `new_person_name`, creates (or reuses on case-insensitive name match) the person first. Returns the `person_id`. |
| `{ action:"face-reject", face_id, person_id }` | Records the rejection and clears the suggestion. |
| `{ action:"face-unconfirm", face_id }` | Detaches a confirmed face; drops the photo link if it was the only reason for it. |
| `{ action:"face-delete", face_id }` | Hard-deletes a spurious detection (poster, reflection). |
| `{ action:"faces-review", limit?, offset?, min_distance?, max_distance? }` | The confirm/reject queue: unnamed faces **with** a suggestion, most-confident first. |
| `{ action:"faces-unknown", limit?, offset? }` | Unnamed faces **without** a suggestion — the "who is this?" pile. |
| `{ action:"faces-status", gallery? }` | `{ scanned_ids, unscanned_count, unnamed_count, suggested_count }` for a progress display. |
| `{ action:"resuggest", max_distance? }` | Full re-sweep of pending suggestions. The function also runs a **targeted** re-suggest after each single confirmation, so the full sweep is rarely needed. |
| `{ action:"photo-tag", photo_id, person_id }` | Manually links a person to a photo (no face), `via='manual'`. |
| `{ action:"photo-untag", photo_id, person_id }` | Removes a manual link. Returns `409` if a confirmed face for that person is still on the photo (unconfirm the face instead — otherwise the trigger would just re-add the tag). |

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

## Importing from other sources

The `import` action re-hosts any batch of image URLs whose host is on the
allowlist above. The two supported one-click sources:

### Google Photos — Picker API
Google retired broad Library/album read access in 2025; the supported path is
the **[Photos Picker API](https://developers.google.com/photos/picker/guides/get-started)**,
wired into the admin page ("📷 Add from Google Photos").

Flow (`photogallery/admin/index.html`): Google Identity Services gets an OAuth
token for the `photospicker.mediaitems.readonly` scope → `POST /v1/sessions`
opens Google's picker → poll the session until `mediaItemsSet` → read
`/v1/mediaItems` → POST each `baseUrl` (`=w2000`) to `action:"import"` with
`source:"google_photos"`, the photo `id` as `external_id`, `createTime` as
`taken_at`, and the OAuth token as `auth`. The import action fetches each photo
server-side with that bearer token (never stored) and re-hosts it.

- **OAuth Client ID** (public, in the admin page): `GOOGLE_CLIENT_ID` constant.
  It's an OAuth *client id*, not a secret. Origins authorized:
  `https://sparcsolutions.org`, `https://www.sparcsolutions.org`.
- Requires the **Google Photos Picker API** enabled and an OAuth consent screen.
- Only works on the production origins above (not Netlify deploy previews).
- Google does **not** expose the person names / face groups you set inside
  Google Photos — those cannot be imported.

### Google Drive — Picker API
For photos already in Google Drive, use the
**[Google Picker API](https://developers.google.com/drive/picker/guides/overview)**.
Same shape: pick files → get temporary download links → POST to `action:"import"`
with `source:"gdrive"`.
