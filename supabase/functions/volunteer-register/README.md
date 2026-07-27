# volunteer-register

Backend for the **volunteer application form** at `/volunteer`
(`js/volunteer-apply.js` is the client).

- **Project:** `ldxpockcgcxvsrbyhcnt` (SPARC Website And Accessibility Project)
- **Endpoint:** `https://ldxpockcgcxvsrbyhcnt.supabase.co/functions/v1/volunteer-register`

## Action

| Payload | Behavior |
| --- | --- |
| `{ name, email, phone?, interests?, availability?, message?, source?, company? }` | Validates (honeypot: `company`), saves to `volunteer_applications`, relays to the Apps Script web app which emails the applicant a confirmation and notifies staff with the full application. |

Applications are **always saved**, even if email sending is unavailable —
the row records `confirmation_sent` / `notification_sent` / `send_error`.

## Why emails go through Google Apps Script

SPARC's Google org **disallows 2-Step Verification**, so Gmail App
Passwords (required for SMTP) cannot be created for work accounts.
Instead, `apps-script.gs` (in this directory) is deployed as a web app by
the work account — **"Execute as: Me"** — which lets it send mail as that
account after a single normal sign-in. The edge function POSTs each
application to the script's `/exec` URL with a shared secret.

Relay settings live in the `volunteer_email_relay_config` table (single row,
RLS enabled, no policies → service-role only):

| Column | Meaning |
| --- | --- |
| `webhook_url` | The Apps Script deployment URL (ends in `/exec`). Null until deployed → emails pause, applications still save. |
| `shared_secret` | Random hex string; must match `SHARED_SECRET` in the deployed script. Never committed. |
| `notify_email` | Optional staff-inbox override; defaults to the script owner. |

### Deploying the script (one-time)

Follow the step-by-step comments at the top of `apps-script.gs`
(script.google.com → paste → set secret → Deploy as web app → copy `/exec`
URL → store in `volunteer_email_relay_config.webhook_url`). After editing an
existing script, use **Deploy → Manage deployments → Edit → New version**
so the same `/exec` URL keeps working.

## Monitoring applications

```sql
select created_at, name, email, phone, interests, availability,
       confirmation_sent, notification_sent, send_error
from public.volunteer_applications
order by created_at desc;
```
