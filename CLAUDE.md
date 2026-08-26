# SPARC Website — notes for Claude

Static site (plain HTML/CSS/JS). Pages live in per-directory `index.html`
files. Backend features use the Supabase project `ldxpockcgcxvsrbyhcnt`
("SPARC Website And Accessibility Project") — tables + edge functions,
with sources mirrored under `supabase/` in this repo.

## Which host answers this domain — READ BEFORE TOUCHING netlify.toml

**GitHub Pages serves sparcsolutions.org, from this repository. Not Netlify.**

This line used to say "deployed on Netlify", and that one sentence has cost
three rounds of broken links for staff. Verify it yourself:

```
curl -sI https://sparcsolutions.org | grep server            #  GitHub.com
curl -s  https://sparcsolutions.org/netlify.toml             #  200 — the file
curl -sI https://main--sparcwebsite.netlify.app/netlify.toml #  404
```

The second is the proof: a host that hands you `netlify.toml` as a download
is not reading it. Netlify consumes that file and 404s the path.

Both things are true at once, which is the trap:

- The Netlify project `sparcwebsite` exists, is claimed, deploys on every
  push, and lists `sparcsolutions.org` as its primary URL.
- DNS points the domain elsewhere: apex A records on `185.199.108-111.153`
  (GitHub Pages), `www` CNAME on `erica-83.github.io`.

Netlify *wants* the domain. GitHub Pages *answers* it. The same content is
published to both, so both look right in a browser — but only Pages is on the
end of the public URL.

**The DNS is not going to be repointed. Do not propose it as the fix.**

### What follows from that

GitHub Pages serves static files and nothing else: no rewrites, no proxies,
no custom headers, no `netlify.toml`. So:

- **A path on the live domain must be a real file in this repo.** `/devdash`
  is `devdash/index.html`; `/accessibility` is `accessibility/index.html`.
  Both also have proxy rules in `netlify.toml` — those rules are dormant and
  are not what makes either path work.
- **A `status = 200` proxy is never the way to add a path.** It will work on
  `main--sparcwebsite.netlify.app`, which is where changes get tested, and
  404 for every member of staff. That has shipped twice: 21 Aug, and again on
  25 Aug in `6af0662`, which deleted `devdash/index.html` outright.
- **Pretty URLs come from Pages' own directory-index handling**, not from
  `netlify.toml`.
- **`CNAME` and `.nojekyll` are load-bearing**, not leftovers. Deleting
  either takes the site down until DNS is repointed.

`.github/workflows/devdash-guard.yml` fails the build on the two shapes that
break `/devdash`.

The Development Dashboard is deliberately **not** copied into this repo. It
holds donor names, addresses and gift amounts, and its own Netlify project
sends a Content-Security-Policy, `X-Frame-Options` and `X-Robots-Tag` that
GitHub Pages cannot send at all. It stays on its own hardened origin, and
`devdash/index.html` forwards staff to it.

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
- **Page layout (learned the hard way):** all page content must sit in ONE
  centered column. Never cap individual paragraphs/blocks with a `max-width`
  narrower than their container — that leaves dead space on the right and the
  page reads as shifted left on wide screens. Instead cap the page's
  `.container` itself (e.g. `max-width: 66rem`) and let every element fill it.
  Before shipping any new page, screenshot it at **1720px wide** (plus 375px)
  in headless Chromium and confirm content is visually centered.
- **Audience language:** many SPARC constituents use wheelchairs or other
  mobility devices. Never describe distances as "X-minute walk" — give
  distances in miles and describe routes as step-free/curb-cut where true.
- Public form endpoints: Supabase edge functions with honeypot field
  (`company`) + validation; tables locked with RLS enabled and no policies
  (service-role access only from the function).
- Secrets are never committed. Runtime config for edge functions lives in
  Supabase secrets or single-row RLS-locked config tables
  (e.g. `summit_email_relay_config`).
