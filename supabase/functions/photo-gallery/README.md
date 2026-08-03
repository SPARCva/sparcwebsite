# photo-gallery

Backend for the public photo gallery at **`/photogallery`** — three albums
(`gala`, `summit`, `life`), each with a year selector, person/caption search,
and a header "scroll" of featured photos kept in chronological order.

- **Project:** `ldxpockcgcxvsrbyhcnt` (SPARC Website And Accessibility Project)
- **Endpoint:** `https://ldxpockcgcxvsrbyhcnt.supabase.co/functions/v1/photo-gallery`
- **Storage bucket:** `gallery` (public read; writes only via this function)
- **Schema**, in order:
  - `migrations/20260729_gallery_people_and_faces_v2.sql` — people roster +
    face recognition v2
  - `migrations/20260729_gallery_resuggest_and_search.sql` — the
    `gallery_list_photos` search helper and `gallery_resuggest_for_person`
  - `migrations/20260730_photographer_upload_token.sql` — the upload-only
    photographer passphrase column
  - `migrations/20260730_unreject_and_thumb_backfill.sql` —
    `gallery_unreject_face` and `gallery_set_thumb`
  - `migrations/20260731_gallery_arcface_recognizer.sql` — **(Tier 3, opt-in)**
    the `embedding_v2 vector(512)` column, the `photo_gallery_config.recognizer`
    flag, and the cosine `*_v2` matching RPCs. Additive and inert until an admin
    opts in from Settings.
  - `migrations/20260803_gallery_match_quality.sql` — match-quality overhaul:
    the `gallery_faces.quality` gate ('ok'/'low'), robust scoring (mean of the
    k nearest exemplars instead of `min()`), a runner-up **margin test** before a
    suggestion is written, and the collapse of the v1/v2 recognizer fork —
    `gallery_match_face` / `gallery_resuggest` / `gallery_resuggest_for_person` /
    `gallery_unreject_face` now read the active recognizer themselves and branch
    internally, so the `*_v2` RPC names are **dropped** and this function no
    longer routes by recognizer. Tuning lives in `gallery_recognizer_params()`.

  All gallery tables are RLS-locked with no policies → service-role only, and
  the `gallery_*` RPCs are granted to `service_role` only. Each new function
  revokes `public`/`anon`/`authenticated` for itself: the v2 migration's
  blanket lockdown only covered functions that existed when it ran, and a
  `SECURITY DEFINER` function is otherwise auto-exposed as an RPC.

## Deploying

The repo only mirrors the function source — nothing here deploys itself, and
Netlify only publishes the static site. After changing `index.ts` or adding a
migration, both have to be applied by hand:

```sh
# 1. Apply any new migrations (in filename order).
#    Via the Supabase SQL editor, or with the CLI:
supabase link --project-ref ldxpockcgcxvsrbyhcnt
supabase db push

# 2. Deploy the function.
supabase functions deploy photo-gallery --project-ref ldxpockcgcxvsrbyhcnt
```

Migrations first, always: the function calls RPCs the migrations create, so a
function deployed against an older schema fails at runtime.

To confirm which version is live without a passphrase, search for a term that
matches nothing:

```sh
curl -s "https://ldxpockcgcxvsrbyhcnt.supabase.co/functions/v1/photo-gallery?action=list&gallery=gala&q=zzzznomatch" \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON"
```

`photos: []` with `featured` still populated means v2 or later (search is pushed
into SQL and only filters `photos`). If `featured` is also empty, the old v1
function is still deployed.

## Pages

| URL | What it is |
| --- | --- |
| `/photogallery/` | Landing page with the three album cards (live cover images) |
| `/photogallery/gala/` · `/summit/` · `/life/` | Public gallery for one album |
| `/photogallery/admin/` | Admin-passphrase tabbed workspace: upload, library, people & faces, review (`noindex`) |
| `/photogallery/upload/` | Photographer-passphrase drop-off; submissions land unpublished for review (`noindex`) |

Client code:

| Path | Role |
| --- | --- |
| `js/photo-gallery.js` · `css/photo-gallery.css` | The **public** gallery engine. Not used by the admin. |
| `css/photo-gallery-admin.css` | Shared by both admin pages. |
| `js/photogallery/api.js` | `api(action, payload)` wrapper, `PGError`, token session, signed PUT. |
| `js/photogallery/ui.js` | Dialogs (focus-trapped), toasts, live region, empty states, concurrency pool. |
| `js/photogallery/imaging.js` | Canvas resize, thumbnails, EXIF capture date, face crops from fractional boxes. |
| `js/photogallery/uploader.js` | The signed direct-to-storage pipeline, shared by both pages. |
| `js/photogallery/faces.js` | face-api.js loading, detection, pixel→fraction box conversion. |
| `js/photogallery/faceapi/` | **Vendored** face-api.js bundle + the three model nets (~8 MB). See the README there. Served from our own origin so face tagging still works at an event on bad wifi, and so no third-party request is made while handling constituents' photos. |
| `js/photogallery/admin.js` | Shell: sign-in, hash router, context bar, Dashboard, Settings. |
| `js/photogallery/admin-upload.js` · `admin-library.js` · `admin-people.js` | The tab views, imported lazily on first visit. |

Views are lazy-loaded, so face-api.js (~1 MB of script plus ~7 MB of model
weights) is fetched only when someone opens **People & Faces** — not on every
admin page load, as the previous single-file page did.

The one third-party script that remains is `accounts.google.com/gsi/client`,
for the Google Photos picker. It **cannot** be vendored: Google requires it to
be served from their origin, and self-hosting a copy is unsupported and breaks
sign-in. It is loaded lazily, only when "Add from Google Photos" is clicked, so
a Google outage affects that one button and nothing else.

## Auth

Every write is a `POST` with an `x-admin-token` header. The value is hashed
(SHA-256) and compared, in constant time, against the stored hashes; the match
resolves to a **role**:

| Role | Passphrase column | May call | Notes |
| --- | --- | --- | --- |
| `admin` | `admin_token_sha256` | everything | The `/photogallery/admin/` tool. |
| `photographer` | `photographer_token_sha256` | `categories`, `upload-urls`, `upload-commit` only | The `/photogallery/upload/` page. Its commits are **forced `published: false`**, so submissions land in the admin review queue. It cannot read the library, edit, or delete. |

An unrecognised or missing token gets a `401` after a ~300 ms delay to blunt
brute-forcing. A **valid photographer token calling an admin action gets `403`**,
not `401` — the passphrase was fine, the action just isn't permitted, and a 401
would send the upload page into a re-authentication loop it can't win. Both hash
comparisons always run so response time doesn't reveal which passphrase was
closer. If `photographer_token_sha256` is `NULL`, photographer uploads are
simply denied.

There is deliberately **no lockout**: a shared passphrase with a lockout would
be a self-inflicted denial of service. Postgres error text is never returned to
the client (it leaks schema); errors are logged server-side and a generic
message is returned.

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
| `{ action:"upload-commit", gallery, year, submission?, published?, items:[{storage_path, thumb_path, caption?, alt_text?, taken_at?, width?, height?, is_featured?, source?}] }` | Inserts rows for objects that were actually PUT. **Each `storage_path` is verified to exist in the bucket first**, so a failed browser PUT can't create an orphan row. Resolves `image_url`/`thumb_url` via `getPublicUrl`, sets `needs_alt` when neither alt nor caption is present. `published` defaults to `true` for an admin (pass `false` to stage a batch) and is **forced to `false`** for a photographer token. `submission` (≤200 chars) is the batch label that groups the review queue. Does **not** accept a `people` field. Returns `{ ok, inserted, ids, skipped }`. |

There is **no idempotency key** on `upload-commit`. If the response is lost in
flight, retrying can double-insert — so a client must not auto-retry a commit
whose outcome is unknown. Retrying after a *confirmed* failure is safe, and
re-committing the same paths is safe, because commit is path-based rather than
session-based.

### Import (re-host external images)

```
{ action:"import", gallery, year, source, items:[{image_url, external_id?, caption?, alt_text?, taken_at?, width?, height?}], auth? }
```

Downloads each image and **re-hosts it in the bucket** (so expiring share URLs
never break), then inserts rows. De-dupes on `(source, external_id)`. ≤200 per
call, ≤25 MB per image. Sets `needs_alt` unless a caption or alt was supplied.

**Imports arrive with `thumb_path` null**, because there is no image library in
the edge runtime. Until a thumbnail exists, `publicRow` falls back to
`thumb_url ?? image_url`, so those photos serve their full-size image into
grids — correct but slow. The two actions below let the browser fill them in.

### Thumbnail backfill

| Payload | Behavior |
| --- | --- |
| `{ action:"thumb-urls", ids:[…] }` | For each photo whose `thumb_path` is null, returns `{ id, image_url, thumb:{path,token,signedUrl} }`. The thumb path is derived from the main object (`<gallery>/<year>/thumbs/<uuid>.jpg`) so it lands beside every other thumbnail. ≤50 per call. Rows that already have a thumbnail, or have no `storage_path`, come back in `skipped`. |
| `{ action:"thumb-commit", items:[{id, thumb_path}] }` | Verifies each object really exists in the bucket, then records it via `gallery_set_thumb`. ≤50 per call. Returns `{ ok, updated, skipped }`. |

`gallery_set_thumb` only ever fills a **null** `thumb_path`, so this can never
repoint an existing thumbnail at another object. `list-admin` accepts
`filter:"no_thumb"` to find the work (photos only — a video's `image_url` is a
provider poster). Driven from the admin's **Settings → Thumbnails**; safe to
re-run, since it only fills in what's absent.

**SSRF allowlist:** `import` only fetches `https:` URLs whose host is (a suffix
of) `googleusercontent.com`, `googleapis.com`, `photoslibrary.googleapis.com`,
`drive.google.com`, `dropboxusercontent.com`, or `dropbox.com`; anything else,
and any private-range / localhost literal, is rejected. Without this the
function would be an open fetch proxy.

### Manage

| Payload | Behavior |
| --- | --- |
| `{ action:"list-admin", gallery?, year?, filter?, limit?, offset? }` | Paginated management grid. `limit` default 100 / max 500, `offset` default 0. `filter` ∈ `needs_alt` / `unscanned` (`face_scanned=false`) / `untagged` (no `gallery_photo_people` rows) / `unpublished` / `no_thumb` (`thumb_path` null, photos only). Returns `{ ok, photos, total }` (`total` is an exact head count for paging). |

Rows from `list-admin` carry both `alt_text` and **`alt_text_raw`**. `alt_text`
is coalesced to the caption (right for the public site — better a caption than
nothing), which would make a photo with only a caption look like it already has
an image description. `alt_text_raw` is the column as stored, so an editor can
tell the two apart and prompt for a real description. `needs_alt` is true only
when **neither** an alt nor a caption is present.
| `{ action:"update", id, patch }` | Edits one row: `caption, alt_text, year, gallery, is_featured, featured_order, sort_order, taken_at, published, submission`. Recomputes `needs_alt` when caption/alt change. |
| `{ action:"bulk-update", ids, patch }` | Same fields across ≤1000 rows; recomputes `needs_alt` for the batch. Approving a review batch is `patch:{published:true}`. |
| `{ action:"delete", id }` | Deletes the row **and both** its storage objects (`storage_path` + `thumb_path`). |
| `{ action:"video-add", gallery, year, video_url, caption?, alt_text?, taken_at?, is_featured?, submission? }` | Adds an embedded YouTube/Vimeo video (`media_type='video'`, embed URL in `video_url`, thumbnail in `image_url`). |
| `{ action:"categories" }` / `{ action:"category-create", name, slug?, is_public? }` | List / create categories. New categories default to `is_public:false` (not served publicly). |
| `{ action:"category-update", slug, patch:{ name?, is_public?, sort_order? } }` | Rename an album or change whether the public site serves it. The **slug is not editable** — it's part of the public URL and of every storage path already written for that album. |

**`people[]` is never written by an `update`/`bulk-update` patch.** It is a
denormalised **cache**, maintained by a trigger from `gallery_photo_people`
(excluding people flagged `hidden`). Sending `people` or `add_people` in a patch
is silently ignored. To tag a photo, use `photo-tag` / face confirmation below;
the trigger rebuilds `people[]`.

## People roster & face recognition

Faces are detected **in the browser** by the open-source **face-api.js**
(`@vladmandic/face-api`). Detection uses the **SSD MobileNet v1** detector over
the full frame plus overlapping tiles (better recall on the small, angled and
partly-hidden faces in event photos); recognition produces **128-float**
descriptors stored in `gallery_faces` as `vector(128)`, and **nothing leaves
SPARC infrastructure**. Matching runs inside Postgres (the `gallery_match_face`
/ `gallery_resuggest*` RPCs), not in JavaScript.

### Suggest → confirm/reject (this is the important part)

Naming a face **does not** write a name across the database. A confirmed face
is an *exemplar* for a person; unnamed faces get a **suggestion** (nearest
exemplar under a distance threshold) that a human then **confirms** or
**rejects**:

- **Confirm** adds the face to that person's exemplar set, so recognition
  improves with use, and links the photo to the person (via
  `gallery_photo_people`, which refreshes `people[]`).
- **Reject** is remembered per `(face, person)`, so a wrong guess is never
  suggested again — even after a re-suggest sweep. **`face-unreject` undoes
  it**, which is what makes Reject safe to offer as a fast keystroke.

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
| `{ action:"face-confirm", face_id, person_id? \| new_person_name? }` | Confirms a face. With `new_person_name`, creates (or reuses on case-insensitive name match) the person first. Returns the `person_id`. Runs a targeted re-suggest afterwards. |
| `{ action:"face-confirm-batch", face_ids:[…], person_id? \| new_person_name? }` | Confirms up to **500** faces as one person, re-suggesting **once** at the end (not per face). Returns `{ ok, person_id, confirmed, failed:[face_id…] }`. Powers the admin's "tag one → tag the rest of the same person" sweep. |
| `{ action:"face-reject", face_id, person_id }` | Records the rejection and clears the suggestion. |
| `{ action:"face-unreject", face_id, person_id, max_distance? }` | Undoes a rejection: drops the `(face, person)` row and recomputes that face's suggestion. Returns `{ ok, suggestion }`, where `suggestion` is `null` if that person is no longer the closest match — so the UI can say "undone, but no longer a match" rather than implying the guess returned. Only re-suggests for a face nobody has named. |
| `{ action:"face-unconfirm", face_id }` | Detaches a confirmed face; drops the photo link if it was the only reason for it. |
| `{ action:"face-delete", face_id }` | Hard-deletes a spurious detection (poster, reflection). |
| `{ action:"faces-review", limit?, offset?, min_distance?, max_distance?, person_id? }` | The confirm/reject queue: unnamed faces **with** a suggestion, most-confident first. `person_id` restricts to faces currently suggested as that one person (used by the "tag the rest" sweep). |
| `{ action:"faces-unknown", limit?, offset? }` | Unnamed faces **without** a suggestion — the "who is this?" pile. Low-quality (gated) faces are excluded from both queues; they stay visible on the photo (`faces-for-photo`) and remain manually taggable. |
| `{ action:"faces-status", gallery? }` | `{ scanned_ids, unscanned_count, unnamed_count, suggested_count, recognizer, bands }` for a progress display. Counts cover gated-in (`quality='ok'`) faces only, matching the queues. `bands` are the active recognizer's confidence-distance cutoffs, so the client labels confidence in the right metric. |
| `{ action:"resuggest", max_distance? }` | Full re-sweep of pending suggestions. `gallery_resuggest` reads the active recognizer (and its ceiling/margin from `gallery_recognizer_params`) itself — no v1/v2 routing. The function also runs a **targeted** re-suggest after each single confirmation, so the full sweep is rarely needed. |
| `{ action:"photo-tag", photo_id, person_id }` | Manually links a person to a photo (no face), `via='manual'`. |
| `{ action:"photo-untag", photo_id, person_id }` | Removes a manual link. Returns `409` if a confirmed face for that person is still on the photo (unconfirm the face instead — otherwise the trigger would just re-add the tag). |

### High-accuracy recognizer (Tier 3, opt-in)

A second, stronger face recognizer — **ArcFace** (512-float embeddings, cosine
distance) — is available alongside the default **face-api** one (128-float,
euclidean). It is opt-in and reversible: the 128-float `embedding` is never
dropped, so switching back is a single flag. `photo_gallery_config.recognizer`
(`'faceapi'` default / `'arcface'`) selects which drives matching. As of
`20260803_gallery_match_quality.sql` the matching RPCs read that flag themselves
and branch between euclidean/`embedding` and cosine/`embedding_v2` internally —
the `*_v2` RPC names are gone and this function no longer routes by recognizer.
Descriptors are still computed **in the browser**
(`js/photogallery/faces-arcface.js`, model vendored under
`js/photogallery/faceapi/arcface/`), so nothing leaves this origin.

Rollout is driven from **Settings → High-accuracy recognizer (beta)**:

| Payload | Behavior |
| --- | --- |
| `{ action:"faces-need-embed", limit?, before? }` | Faces with no `embedding_v2` yet, newest-first, with `box`, `image_url` and `created_at`. `before` (a `created_at`) is the keyset cursor for the re-embed pass so faces that can't be embedded aren't re-fetched forever. |
| `{ action:"faces-embed-batch", items:[{face_id, embedding_v2[512]}] }` | Stores browser-computed ArcFace embeddings (≤200). Returns `{ ok, saved, failed:[…] }`. |
| `{ action:"recognizer-status" }` | `{ recognizer, total_faces, embedded_v2, bands }` for the rollout panel. |
| `{ action:"recognizer-set", recognizer }` | Flips the active recognizer (`'faceapi'`\|`'arcface'`). Switching to `arcface` is refused until at least one confirmed face has an embedding. The client runs `resuggest` afterwards to recompute in the new metric. |

The distance thresholds — `gallery_recognizer_params()` (ceiling + runner-up
margin, per recognizer, in the DB) and the `RECOGNIZER_BANDS` confidence
sub-bands echoed from `index.ts` — are conservative starting points. They were
loosened when scoring moved from `min()` to a mean of the k nearest exemplars,
and should be tuned on real photos: raise the ceiling if true matches land in
"Who is this?", raise the margin if confident suggestions turn out wrong.

## Setting the passphrases

Both are stored only as SHA-256 hashes. To set or rotate either:

```sql
-- compute the hash of your chosen passphrase, e.g.:
--   printf '%s' 'YOUR-PASSPHRASE' | sha256sum

-- admin (full access, /photogallery/admin/)
update public.photo_gallery_config
set admin_token_sha256 = '<64-char-hex>', updated_at = now()
where id = true;

-- photographer (upload only, /photogallery/upload/)
update public.photo_gallery_config
set photographer_token_sha256 = '<64-char-hex>', updated_at = now()
where id = true;
```

Then sign in at the matching page with the plaintext passphrase. Until a hash is
set, that role is denied. To revoke photographer access, set its column back to
`null`. Schema: `migrations/20260730_photographer_upload_token.sql`.

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
