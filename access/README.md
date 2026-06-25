# Steps Toward Access

SPARC's accessibility advocacy app. Two surfaces:

- **`public.html`** — public-facing mobile web app. Visitors browse documented
  accessibility barriers at Reston Town Center (map + list + detail sheet) and
  can prepare a `mailto:` message about a barrier in their own community. The
  app never sends email and never stores visitor submissions. No login.
- **`admin.html`** — internal "Team Console." Staff add and edit barriers
  (location, photos with required alt-text, correspondence log). Entries save
  as **Draft** and only appear on the public page once **Published**. Requires
  magic-link sign-in.

The frontend is hand-styled static HTML/CSS/JS (no framework, no build step).
All backend access is isolated in the `js/` modules.

```
access/
  public.html              # public page
  admin.html               # team console (+ auth gate)
  js/
    supabaseClient.js       # configured Supabase client (put your keys here)
    dataLayer.public.js     # read-only DataLayer (anon key)
    dataLayer.admin.js      # full CRUD DataLayer
    auth.js                 # magic-link sign-in / session guard
  supabase/
    migrations/             # reproducible SQL (schema, RLS, storage)
    seed.sql                # optional sample data
  .env.example              # documents the two required values
```

## Tech stack

- **Backend:** Supabase (Postgres + Auth + Storage). Free tier is fine.
- **Frontend:** static HTML/CSS/JS, Supabase JS client loaded from CDN
  (`https://esm.sh/@supabase/supabase-js@2`).
- **Auth:** Supabase magic-link (email) for the admin console only.
- **Photos:** Supabase Storage, public-read bucket `barrier-photos`.

## 1. Configure the client

There is no build step, so the project URL and anon key are pasted directly
into `js/supabaseClient.js`:

```js
const SUPABASE_URL = 'https://YOUR-PROJECT.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR-ANON-PUBLIC-KEY';
```

Find both in the Supabase dashboard under **Project Settings → API**. The
anon/public key is safe to expose in the browser — that is its purpose. Row
Level Security is what actually protects the data. **Never** put the
service-role key here. See `.env.example`.

## 2. Run the migrations

Using the Supabase CLI (recommended — reproducible):

```bash
supabase link --project-ref YOUR-PROJECT-REF
supabase db push                       # applies everything in supabase/migrations/
```

Or paste each file in `supabase/migrations/` into the dashboard SQL editor, in
order:

1. `0001_schema.sql` — the three tables (`locations`, `photos`, `events`).
2. `0002_rls.sql` — Row Level Security: the Draft/Published review gate.
3. `0003_storage.sql` — the `barrier-photos` bucket + storage policies.

Optionally load sample data: `supabase/seed.sql`.

### How the review gate is enforced

RLS (`0002_rls.sql`) lets the **anon** role read only `published = true`
locations and their child photos/events. Because the public page uses the anon
key, an unpublished barrier is invisible to it **at the database layer**, even
if a UI bug tried to request it. Authenticated staff can read drafts, write,
and delete. The `published = true` filter in `dataLayer.public.js` is
belt-and-suspenders on top of this.

## 3. Storage bucket

`0003_storage.sql` creates the public-read `barrier-photos` bucket and its
policies (anon read; authenticated write/delete). If you prefer the dashboard:
**Storage → New bucket → `barrier-photos` → Public**, then apply the two
policies from that file.

Uploaded files are named `${location_id}/${uuid}-${safeName}` so they group by
location; deleting a barrier best-effort-cleans its folder.

## 4. Invite a staff member

The admin console uses passwordless magic links. To let someone in:

- **Supabase dashboard → Authentication → Users → Invite user**, enter their
  email; or
- have them enter their email on the console sign-in screen and click
  **Send me a sign-in link** (works for any address unless you restrict
  sign-ups).

To restrict who can sign in, configure allowed emails / disable open sign-ups
under **Authentication → Providers / Sign-In settings**, or harden the RLS
policies against a `staff_emails` table (template in `0002_rls.sql`).

> The RLS policies currently grant full access to **any** authenticated user,
> so control access by controlling who receives a link. Tightening this to a
> fixed allow-list is a SPARC-team decision — see **Open items**.

## 5. Deploy into the SPARC site

The site is static and served from the repo root (Netlify, with pretty URLs).
The `access/` folder ships as-is:

- `https://sparcsolutions.org/access/public.html` — public page
- `https://sparcsolutions.org/access/admin.html` — team console

Link to the public page from the main site's accessibility / advocacy sections.
The console's **View public page ↗** button already points at `public.html`.

When configuring the magic-link redirect, add the deployed admin URL to
**Authentication → URL Configuration → Redirect URLs** in Supabase (e.g.
`https://sparcsolutions.org/access/admin.html`), plus `http://localhost:...`
for local testing. `auth.js` redirects back to the current admin URL.

### Local testing

ES modules need to be served over HTTP (not opened as `file://`). From the
repo root:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000/access/public.html
```

## Test checklist (run before calling it done)

- [ ] As anon (public page, logged out): only published barriers load; drafts
      never appear — confirm in the Network tab response, not just the UI.
- [ ] Saving a photo with empty alt text is rejected (DB `alt_not_blank`
      constraint **and** the UI guard both fire).
- [ ] Publish → barrier appears on the public page; Unpublish → it disappears.
- [ ] Delete cascades (no orphan photo/event rows; Storage folder cleaned up).
- [ ] Keyboard-only: open/close the detail sheet and editor modal — focus is
      trapped and restored, Escape closes.
- [ ] Mobile Safari + Chrome: bottom-sheet swipe-to-dismiss, safe-area insets,
      `mailto:` opens the mail app with subject/body pre-filled.
- [ ] Lighthouse accessibility score ≥ 95 on both pages.

## Accessibility (do not regress)

This is a site about accessibility. The following must survive any change:
keyboard focus traps in sheets/modals, visible focus rings, `aria-*`
attributes, the **required** alt-text on every photo, reduced-motion support,
and the text-list alternative to the map.

## Open items (for the SPARC team — intentionally not solved in code)

1. **Legal review** of the visitor `mailto:` template and of published content
   about named parties.
2. **The final staff email allow-list** — who may sign in to the console (see
   §4 and the `staff_emails` template in `0002_rls.sql`).

## What NOT to do

- Don't rebuild the UI or add a CSS/component framework — the pages are
  hand-styled.
- Don't add server-side email sending for visitor submissions (`mailto:` only,
  by design — a liability decision already made).
- Don't weaken RLS to "make it work" — the review gate depends on it.
- Don't commit real keys or the service-role key.
- Don't drop the alt-text requirement or the reduced-motion / focus-trap
  behavior.
