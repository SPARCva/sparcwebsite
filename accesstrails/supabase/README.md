# Access Trails — Contribute form backend (PROPOSED)

> **Status: proposed, NOT applied.** These migrations describe the backend the
> Contribute form needs. Per the migration plan, the schema is written here for
> review and is **not** applied to Supabase until SPARC signs off. The form is
> gated by `SUBMISSIONS_ENABLED = false` in `js/supabaseClient.js` until then.

## What it creates
1. `0001_schema.sql` — table `public.access_trails_submissions` (one row per
   public submission; staff-triaged via a `status` column; nothing public).
2. `0002_rls.sql` — Row Level Security: the **anon** role may `INSERT` only
   (no read/update/delete); authenticated staff may read and triage.
3. `0003_storage.sql` — **private** Storage bucket `access-trails-submissions`;
   anon may upload only; staff read via signed URLs.

This mirrors the pattern of the existing `/access` tool (`access/supabase/`),
but inverts the direction: there the public *reads* published rows; here the
public *submits* rows that stay private until staff review them.

## To apply (after approval)
```bash
supabase link --project-ref ldxpockcgcxvsrbyhcnt
supabase db push          # applies 0001 -> 0002 -> 0003 in order
```
Or paste each file into the dashboard SQL editor in order. Then flip
`SUBMISSIONS_ENABLED = true` in `js/supabaseClient.js`.

## Spam mitigation
- **Honeypot** hidden `website` field (bots that fill it are silently dropped).
- **Client rate limit** — one submit per 30s per browser (localStorage).
- **Optional DB rate guard** — a commented trigger in `0002_rls.sql` caps
  anonymous inserts per minute (defense in depth); enable if abuse appears.
- CHECK constraints bound `park_name`/`description` length and force
  `status = 'new'` on anonymous insert.

## Open items for SPARC
- Confirm the staff triage surface (dashboard vs. a small authenticated console
  like `/access/admin.html`).
- Decide retention / moderation policy for submitted photos.
