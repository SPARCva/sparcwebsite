-- Config for the summit email relay (Google Apps Script web app).
-- Single-row table read only by the virtual-summit-register edge function
-- (service role). RLS enabled with no policies = invisible to anon/public.
--
-- Why a relay: SPARC's Google org disallows 2-Step Verification, so Gmail
-- App Passwords (SMTP) are impossible. An Apps Script web app deployed by
-- the work account sends mail as that account with a normal sign-in.
-- See supabase/functions/virtual-summit-register/apps-script.gs.
--
-- Applied to project ldxpockcgcxvsrbyhcnt on 2026-07-14. The shared_secret
-- value is set directly in the database, never committed.

create table if not exists public.summit_email_relay_config (
  id boolean primary key default true check (id),  -- enforce single row
  webhook_url text,                                -- Apps Script /exec URL (null until deployed)
  shared_secret text not null,                     -- gates the relay
  notify_email text,                               -- staff inbox; null = script default
  updated_at timestamptz not null default now()
);

alter table public.summit_email_relay_config enable row level security;
