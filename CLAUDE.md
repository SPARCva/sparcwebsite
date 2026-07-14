# SPARC Website — notes for Claude

Static site (plain HTML/CSS/JS) deployed on Netlify at www.sparcsolutions.org.
Pages live in per-directory `index.html` files (pretty URLs via netlify.toml).
Backend features use the Supabase project `ldxpockcgcxvsrbyhcnt`
("SPARC Website And Accessibility Project") — tables + edge functions,
with sources mirrored under `supabase/` in this repo.

## Org constraints — READ BEFORE SUGGESTING EMAIL/AUTH SETUPS

- **SPARC's Google organization does NOT allow 2-Step Verification** on
  work accounts (e.g. erica@sparcsolutions.org). Therefore:
  - **Gmail App Passwords are impossible** (Google requires 2SV for them).
    Never propose SMTP-with-app-password for a sparcsolutions.org mailbox.
  - Do not propose sending from personal Gmail accounts to constituents —
    outgoing email to registrants/donors must come from a work address.
- **The approved pattern for sending email from a work account** is a
  Google Apps Script web app deployed by that account ("Execute as: Me",
  access: Anyone), called server-side with a shared secret. Apps Script
  sends as the deploying account with a normal sign-in — no 2SV needed.
  Working example: `supabase/functions/virtual-summit-register/`
  (see `apps-script.gs` + `README.md` there). Reuse this pattern.
- The `gmail_tokens` table in the Supabase project belongs to a separate
  donor-CRM backend. Do not reuse or refresh its OAuth tokens.

## Conventions

- Match existing page structure: inline header/footer per page, shared
  `/css/styles.css` variables (`--sparc-kelly-green`, `--sparc-royal-blue`,
  `--sparc-dark-navy`, ...), Montserrat/Open Sans fonts, gtag snippet.
- Public form endpoints: Supabase edge functions with honeypot field
  (`company`) + validation; tables locked with RLS enabled and no policies
  (service-role access only from the function).
- Secrets are never committed. Runtime config for edge functions lives in
  Supabase secrets or single-row RLS-locked config tables
  (e.g. `summit_email_relay_config`).
