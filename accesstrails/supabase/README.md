# Access Trails — Contribute / Submissions / Console backend (LIVE)

Backed by SPARC's existing Supabase project (`ldxpockcgcxvsrbyhcnt`, "SPARC
Website And Accessibility Project") — the same one the `/access` tooling uses.
**Applied 2026-07.** The migrations in `migrations/` document exactly what is
live.

## Surfaces
1. **`/accesstrails/contribute/`** — public form. Anonymous `INSERT` into
   `access_trails_submissions` (+ optional photo upload). Anyone can submit.
2. **`/accesstrails/submissions/`** — public. Reads the PII-safe
   `access_trails_public` view (only rows staff marked `shown_publicly`, only
   non-personal columns). No login.
3. **`/accesstrails/console/`** — staff Team Console. Email + password
   (`signInWithPassword` / `signUp`), **mirroring the /ART app — no magic links,
   so no Resend/SMTP is needed**. Staff triage submissions and (admins) manage
   the roster.

## Authorization — reuses the shared roster
Authorization is the shared `access_staff` table via `access_role()` (returns
`admin` | `editor` | `contributor` | `''`). Only emails on the roster can read
or triage anything — enforced by RLS, not just the UI.

- **Admins** (e.g. `andrew@sparcsolutions.org`, already an admin) can add or
  remove **any** email — SPARC staff or outside volunteers — right from the
  console's "Team roster" panel (the existing `"admin manages roster"` policy).
- A newly added person goes to the console, enters their email, and picks
  **Create a password** (`signUp`). Because this project has email confirmation
  disabled (that is how /ART works without an email service), they get an active
  session immediately — no email is ever sent.
- Password reset: ask an admin (same as /ART: "Forgot password? Ask Erica or
  Andrew.").

## RLS summary
- `access_trails_submissions`: anon `INSERT` only, constrained to
  `status='new'`, no `team_note`, `shown_publicly=false` (verified: a
  self-publish attempt returns 401). Staff (`access_role() <> ''`) full access.
  Anon cannot `SELECT` the raw table (personal data never exposed).
- `access_trails_public` view: anon `SELECT` (published, non-personal only).
- Storage `access-trails-photos` (public bucket, mirrors barrier/report-photos):
  anon upload; anon read; staff manage.

## Spam mitigation
Honeypot field + client 30s rate-limit + length CHECK constraints + the
anon-insert-only shape. A DB-side per-minute rate guard can be added later if
abuse appears.

## Notes for SPARC
- The photo bucket is public-read (consistent with the existing SPARC access
  buckets). Any uploaded image is reachable by URL; staff should archive/delete
  spam or sensitive photos during triage.
- Roster changes here affect the shared SPARC Access roster (same `access_staff`
  used by `/access`).
