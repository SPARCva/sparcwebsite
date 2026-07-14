# virtual-summit-register

Backend for the **"Join Virtually for Free"** flow on the SPARC summit
("A Call to Conscience"). Powers the modal on `/summit` and the standalone
`/virtualsummit` registration page (`js/summit-virtual.js` is the client).

- **Project:** `ldxpockcgcxvsrbyhcnt` (SPARC Website And Accessibility Project)
- **Endpoint:** `https://ldxpockcgcxvsrbyhcnt.supabase.co/functions/v1/virtual-summit-register`

## Actions

| Action | Payload | Behavior |
| --- | --- | --- |
| `register` (default) | `{ name, email, source?, company? }` | Validates (honeypot: `company`), saves to `summit_virtual_registrations`, relays to the Apps Script web app which emails the registrant the Zoom details and notifies staff. |
| `lookup` | `{ action: "lookup", email }` | Returns `{ ok, registered, name? }` so returning attendees can reveal the "Join the Livestream" button without re-registering. |

Registrations are **always saved**, even if email sending is unavailable —
the row records `confirmation_sent` / `notification_sent` / `send_error`.

## Why emails go through Google Apps Script

SPARC's Google org **disallows 2-Step Verification**, so Gmail App
Passwords (required for SMTP) cannot be created for work accounts.
Instead, `apps-script.gs` (in this directory) is deployed as a web app by
the work account — **"Execute as: Me"** — which lets it send mail as that
account after a single normal sign-in. The edge function POSTs each
registration to the script's `/exec` URL with a shared secret.

Relay settings live in the `summit_email_relay_config` table (single row,
RLS enabled, no policies → service-role only):

| Column | Meaning |
| --- | --- |
| `webhook_url` | The Apps Script deployment URL (ends in `/exec`). Null until deployed → emails pause, registrations still save. |
| `shared_secret` | Random hex string; must match `SHARED_SECRET` in the deployed script. Never committed. |
| `notify_email` | Optional staff-inbox override; defaults to the script owner. |

### Deploying / redeploying the script

Follow the step-by-step comments at the top of `apps-script.gs`
(script.google.com → paste → set secret → Deploy as web app → copy URL →
store in `summit_email_relay_config.webhook_url`). After editing an
existing script, use **Deploy → Manage deployments → Edit → New version**
so the same `/exec` URL keeps working.

## Monitoring registrations

```sql
select created_at, name, email, source, confirmation_sent, notification_sent, send_error
from public.summit_virtual_registrations
order by created_at desc;
```
