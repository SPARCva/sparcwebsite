-- SPARC Email → Bloomerang pipeline — Phases 1-3 shared schema (§4).
-- Applied to project ldxpockcgcxvsrbyhcnt.
-- ---------------------------------------------------------------------------
-- The live-triage / earned-automation / backfill schema: a lookup cache of
-- Bloomerang IDs, the staging queue (crm_inbox) with its attachments, trust
-- rules that gate auto-posting, and the full push audit log.
--
-- Hard rules baked into the schema (see build brief Part 1):
--   §1.2 Transactions never auto-post — enforced here by the crm_trust_rule
--        `no_money` CHECK constraint (code-level refusal + absent UI path are
--        the other two layers).
--   §1.4 The Bloomerang Authorization header is NEVER stored — crm_push_log
--        holds request_body only, and the push function redacts before logging.
--   §1.7 dedupe_key is UNIQUE on crm_inbox — re-ingesting a message is a no-op.
--
-- Access model (§4.6): service_role has full access (bypasses RLS) and is the
-- only writer. The authenticated (review-UI) role gets SELECT/UPDATE on
-- crm_inbox and crm_inbox_attachment and SELECT on the read-only reference
-- tables; it can never INSERT or DELETE. anon gets nothing.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- §4.1 Lookup cache (Bloomerang funds / campaigns / appeals / custom fields)
-- ---------------------------------------------------------------------------
create table if not exists public.crm_lookup (
  id            bigserial primary key,
  kind          text not null check (kind in
                  ('fund','campaign','appeal','custom_field','custom_field_value','user')),
  bloomerang_id bigint not null,
  name          text not null,
  parent_id     bigint,                    -- owning custom field for pick values
  synced_at     timestamptz not null default now(),
  unique (kind, bloomerang_id)
);

-- ---------------------------------------------------------------------------
-- §4.2 Staging queue
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'crm_inbox_status') then
    create type public.crm_inbox_status as enum
      ('pending','extracted','needs_review','approved','rejected',
       'pushed','auto_posted','failed','already_present');
  end if;
end $$;

create table if not exists public.crm_inbox (
  id                        uuid primary key default gen_random_uuid(),
  dedupe_key                text not null unique,   -- gmail_message_id:part_index
  gmail_message_id          text not null,
  gmail_thread_id           text not null,
  gmail_permalink           text,
  source                    text not null check (source in
                              ('scan','debi_cc','donation','debi_request','general','backfill')),
  sweep_week                text,                    -- backfill only, 'YYYY-WW'
  received_at               timestamptz not null,
  from_name                 text,
  from_email                text,
  subject                   text,
  raw_body                  text,
  status                    public.crm_inbox_status not null default 'pending',
  record_type               text,                    -- see §7.2
  tier                      smallint,                -- 1 bulk / 2 cards / 3 money
  extraction                jsonb,
  extraction_confidence     numeric(3,2),
  extraction_model          text,
  extraction_error          text,
  validation_flags          text[] not null default '{}',
  suppression_reason        text,                    -- for already_present
  match_constituent_id      bigint,
  match_score               numeric(3,2),
  match_method              text,                    -- email_exact|sender_map|org_name_exact|name_zip|name_loose|none
  match_candidates          jsonb,
  proposed_payload          jsonb,
  reviewed_by               text,
  reviewed_at               timestamptz,
  review_notes              text,
  auto_posted               boolean not null default false,
  trust_rule_id             bigint,
  pushed_at                 timestamptz,
  bloomerang_constituent_id bigint,
  bloomerang_transaction_id bigint,
  bloomerang_note_id        bigint,
  bloomerang_interaction_id bigint,
  bloomerang_task_id        bigint,
  push_error                text,
  digest_sent_at            timestamptz,
  reverted_at               timestamptz,
  reverted_by               text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);
create index if not exists crm_inbox_status_tier_received_idx
  on public.crm_inbox (status, tier, received_at desc);
create index if not exists crm_inbox_from_email_idx on public.crm_inbox (from_email);
create index if not exists crm_inbox_sweep_week_idx on public.crm_inbox (sweep_week);

-- Standard updated_at trigger (this repo defines a touch fn per domain rather
-- than sharing one; follow that convention).
create or replace function public.crm_inbox_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''          -- pinned: donor-data table, no unqualified refs needed
as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists crm_inbox_touch_updated_at_trg on public.crm_inbox;
create trigger crm_inbox_touch_updated_at_trg
  before update on public.crm_inbox
  for each row execute function public.crm_inbox_touch_updated_at();

-- ---------------------------------------------------------------------------
-- §4.3 Attachments (files live in Drive permanently; Bloomerang gets URLs)
-- ---------------------------------------------------------------------------
create table if not exists public.crm_inbox_attachment (
  id             uuid primary key default gen_random_uuid(),
  inbox_id       uuid not null references public.crm_inbox(id) on delete cascade,
  filename       text not null,
  mime_type      text,
  size_bytes     bigint,
  drive_file_id  text,
  drive_url      text,
  kind           text,       -- sponsorship_agreement|w9|check_image|logo|invoice|guest_list|correspondence|other
  relevant_to    text,       -- constituent|transaction|note
  extracted_text text,
  created_at     timestamptz not null default now()
);
create index if not exists crm_inbox_attachment_inbox_idx
  on public.crm_inbox_attachment (inbox_id);

-- ---------------------------------------------------------------------------
-- §4.4 Trust rules — the `no_money` constraint is one of the three layers
-- enforcing §1.2 (transactions never auto-post).
-- ---------------------------------------------------------------------------
create table if not exists public.crm_trust_rule (
  id           bigserial primary key,
  source       text not null,
  record_type  text not null,
  match_method text not null,
  sender_email text,                       -- null = any sender within source
  enabled      boolean not null default true,
  created_from uuid references public.crm_inbox(id),
  created_by   text not null,
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz,
  constraint no_money check (record_type not in
    ('donation_received','pledge','transaction'))
);

-- ---------------------------------------------------------------------------
-- §4.5 Push audit log — the ONLY complete record of what the pipeline wrote
-- to Bloomerang (§1.3). request_body NEVER contains the Authorization header.
-- ---------------------------------------------------------------------------
create table if not exists public.crm_push_log (
  id              bigserial primary key,
  inbox_id        uuid references public.crm_inbox(id) on delete cascade,
  attempted_at    timestamptz not null default now(),
  method          text,
  endpoint        text,
  request_body    jsonb,                   -- Authorization header NEVER stored
  response_status int,
  response_body   jsonb
);
create index if not exists crm_push_log_inbox_idx
  on public.crm_push_log (inbox_id, attempted_at desc);

-- ---------------------------------------------------------------------------
-- §4.6 RLS
-- ---------------------------------------------------------------------------
alter table public.crm_lookup           enable row level security;
alter table public.crm_inbox            enable row level security;
alter table public.crm_inbox_attachment enable row level security;
alter table public.crm_trust_rule       enable row level security;
alter table public.crm_push_log         enable row level security;

-- authenticated (review UI): SELECT + UPDATE on the queue and its attachments.
drop policy if exists crm_inbox_auth_select on public.crm_inbox;
create policy crm_inbox_auth_select
  on public.crm_inbox for select to authenticated using (true);

drop policy if exists crm_inbox_auth_update on public.crm_inbox;
create policy crm_inbox_auth_update
  on public.crm_inbox for update to authenticated using (true) with check (true);

drop policy if exists crm_inbox_attachment_auth_select on public.crm_inbox_attachment;
create policy crm_inbox_attachment_auth_select
  on public.crm_inbox_attachment for select to authenticated using (true);

drop policy if exists crm_inbox_attachment_auth_update on public.crm_inbox_attachment;
create policy crm_inbox_attachment_auth_update
  on public.crm_inbox_attachment for update to authenticated using (true) with check (true);

-- authenticated: SELECT only on the reference tables.
drop policy if exists crm_lookup_auth_select on public.crm_lookup;
create policy crm_lookup_auth_select
  on public.crm_lookup for select to authenticated using (true);

drop policy if exists crm_trust_rule_auth_select on public.crm_trust_rule;
create policy crm_trust_rule_auth_select
  on public.crm_trust_rule for select to authenticated using (true);

drop policy if exists crm_push_log_auth_select on public.crm_push_log;
create policy crm_push_log_auth_select
  on public.crm_push_log for select to authenticated using (true);

-- No INSERT / DELETE policies for authenticated on any table, and no anon
-- policies anywhere: those roles are denied. service_role bypasses RLS.

comment on table public.crm_inbox is
  'Email → Bloomerang triage staging queue. Every proposed CRM write lands here first and is human-approved before crm-push runs. dedupe_key (gmail_message_id:part_index) is UNIQUE so re-ingest is a no-op (§1.7). Service role writes; authenticated review UI may SELECT/UPDATE only.';
comment on table public.crm_push_log is
  'Full audit trail of every Bloomerang API write attempt (request + response, with returned record IDs). The Authorization header is never stored (§1.4). This log — not a Bloomerang search — is the source for undo and mass-correction (§1.3).';
comment on constraint no_money on public.crm_trust_rule is
  'Enforces §1.2: no trust rule may auto-post a transaction. Backed independently by a code refusal in crm-push and the absence of any auto-post UI path.';
