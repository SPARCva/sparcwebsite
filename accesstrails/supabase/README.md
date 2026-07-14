# Access Trails — Notes / Submissions / Console backend (LIVE, /ART parity)

Backed by SPARC's existing Supabase project (`ldxpockcgcxvsrbyhcnt`, "SPARC
Website And Accessibility Project") — the same one the `/access` tooling and
the /ART app use. **Migrations 0001–0003 applied 2026-07; 0004 applied
2026-07 (v2, /ART parity).** The migrations in `migrations/` document exactly
what is live.

## Surfaces
1. **Every center page** (`/accesstrails/{alexandria,arlington,leesburg,mclean}/`)
   and **every park page** (`/accesstrails/parks/<slug>/`) — an
   "Accessibility Notes" section: a feed of notes for that place plus an
   /ART-style submission form (grouped amenity picker with hints, description,
   photo, optional contact). Anyone can post; a signed-in roster member posts
   as **SPARC Team**. Notes are scoped by `location_slug` / `park_slug`.
2. **`/accesstrails/contribute/`** — the general form for parks not yet in the
   guide (optional area + amenity scoping routes notes onto the area pages).
3. **`/accesstrails/submissions/`** — public board of ALL notes (team +
   community) with per-area filters. **Instant display**, mirroring /ART
   v2.4: notes appear the moment they're posted, via the PII-safe
   `access_trails_community` view (`status not in ('archived','spam')`,
   non-personal columns only). Staff Archive/Spam are the removal levers.
4. **`/accesstrails/console/`** — staff Team Console, mirroring the /ART
   console: status tabs (new/reviewed/archived/spam) + area filters, edit,
   internal team notes, archive/spam/restore/delete, an **Add a field note**
   form that posts as SPARC Team, and (admins) roster management.
   Email + password (`signInWithPassword` / `signUp`), **no magic links, so no
   Resend/SMTP is needed** (email confirmation is disabled on this project,
   same as /ART).

## Authorization — reuses the shared roster
Authorization is the shared `access_staff` table via `access_role()` (returns
`admin` | `editor` | `contributor` | `''`). Only emails on the roster can read
the raw table or triage anything — enforced by RLS, not just the UI.

- **Admins** (e.g. `andrew@sparcsolutions.org`) add or remove **any** email —
  SPARC staff or outside volunteers — from the console's "Team roster" panel.
- A newly added person goes to the console, enters their email, and picks
  **Create a password** (`signUp`) — they get an active session immediately;
  no email is ever sent. Password reset: ask an admin (same as /ART).

## RLS summary
- `access_trails_submissions`: anon `INSERT` only, constrained to
  `status='new'`, no `team_note`, `shown_publicly=false`, **`source='public'`,
  `submitted_by is null`** (anon cannot spoof a SPARC Team note). Same shape
  for signed-in non-roster users. Staff (`access_role() <> ''`) full access —
  team notes insert with `source='team'`, `submitted_by=email`,
  `status='reviewed'`. Anon cannot `SELECT` the raw table (personal data never
  exposed).
- `access_trails_community` view: anon `SELECT`; instant display of every
  non-archived/non-spam row; only non-personal columns (no reporter identity,
  no contact info, no staff emails — team rows show only the label).
- `access_trails_public` view (legacy, publish-gated): still present; the
  pages now read `access_trails_community`.
- Storage `access-trails-photos` (public bucket, mirrors barrier/report-photos):
  anon upload; anon read; staff manage.

## Spam mitigation
Honeypot field + client 30s rate-limit + length/enum CHECK constraints + the
anon-insert-only shape. Instant display means spam is visible until staff
archive it — the same tradeoff /ART accepted in v2.4 ("Dismiss is the only
removal lever"); the console's New tab + status counts make cleanup quick.
A DB-side per-minute rate guard can be added later if abuse appears.

## Notes for SPARC
- The photo bucket is public-read (consistent with the existing SPARC access
  buckets). Any uploaded image is reachable by URL; staff should archive/spam
  entries with problem photos during triage (archiving hides the note and its
  photos from all public pages).
- Roster changes here affect the shared SPARC Access roster (same
  `access_staff` used by `/access` and /ART).
- Location/amenity taxonomies live in `accesstrails/js/catalog.js` and are
  mirrored by CHECK constraints in migration 0004 and the optgroups in
  `accesstrails/build/generate.js` — update all together.
