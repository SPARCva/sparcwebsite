-- SPARC Email → Bloomerang pipeline — Phase 0: snapshot + dedupe schema.
-- Applied to project ldxpockcgcxvsrbyhcnt.
-- ---------------------------------------------------------------------------
-- This migration creates the read-only reference snapshot of Erica's
-- Bloomerang CSV export (snap_* tables), the sender-map / collision tables
-- that seed matching, and the duplicate-constituent worklist table.
--
-- Nothing here ever writes to Bloomerang. The snap_* tables are a mirror of
-- a manual export, loaded truncate-and-reload by scripts/load-bloomerang-
-- snapshot.ts, and are the sole input to the dedupe worklist and to the
-- backfill novelty checks (they are NOT a source of truth Bloomerang reads
-- back).
--
-- Access model: every snap_* table plus crm_sender_map / crm_sender_collision
-- is RLS-enabled with NO policies, so only the service role (edge functions /
-- loader scripts) can touch them. The export carries participant program data
-- (waiver types, disability status, emergency contacts, DSP details) — §1.8 of
-- the build brief requires these tables be invisible to the authenticated
-- (review-UI) role, which the no-policy lockdown enforces. crm_duplicate_
-- candidate is the one Phase-0 table the review UI reads, so it additionally
-- grants SELECT to authenticated.
--
-- Each snap_* table keeps the handful of columns the dedupe and novelty logic
-- needs as typed columns, plus a `raw` jsonb holding the complete CSV row so
-- no exported field is lost and the loader can evolve without a schema change.
-- ---------------------------------------------------------------------------

-- Trigram similarity is used by the backfill novelty checks (§7.5) against
-- snap_interactions.subject and snap_attachments.filename. Already installed
-- on this project; the guard keeps the migration re-runnable elsewhere.
create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------------
-- Constituents
-- ---------------------------------------------------------------------------
create table if not exists public.snap_constituents (
  account_number     bigint primary key,        -- Bloomerang AccountNumber / constituent id
  constituent_type   text,                       -- 'Individual' | 'Organization'
  status             text,                       -- e.g. 'Active' | 'Inactive'
  is_inactive        boolean not null default false,
  is_deceased        boolean not null default false,
  first_name         text,
  middle_name        text,
  last_name          text,
  full_name          text,
  organization_name  text,
  primary_email      text,
  role_at_sparc      text,                       -- Custom: Role at SPARC (Participant / Direct Support Professional / ...)
  lifetime_giving    numeric,
  created_date       timestamptz,
  raw                jsonb,                      -- full CSV row
  snapshot_date      date not null,
  loaded_at          timestamptz not null default now()
);
create index if not exists snap_constituents_last_name_idx
  on public.snap_constituents (lower(last_name));
create index if not exists snap_constituents_type_idx
  on public.snap_constituents (constituent_type);

-- ---------------------------------------------------------------------------
-- Emails  (one row per email address on a constituent)
-- ---------------------------------------------------------------------------
create table if not exists public.snap_emails (
  id             bigserial primary key,
  account_number bigint not null,
  email          text not null,
  email_type     text,
  is_primary     boolean not null default false,
  raw            jsonb,
  snapshot_date  date not null,
  loaded_at      timestamptz not null default now()
);
create index if not exists snap_emails_account_idx on public.snap_emails (account_number);
create index if not exists snap_emails_email_idx    on public.snap_emails (lower(email));

-- ---------------------------------------------------------------------------
-- Phones
-- ---------------------------------------------------------------------------
create table if not exists public.snap_phones (
  id             bigserial primary key,
  account_number bigint not null,
  number         text,
  phone_type     text,
  is_primary     boolean not null default false,
  raw            jsonb,
  snapshot_date  date not null,
  loaded_at      timestamptz not null default now()
);
create index if not exists snap_phones_account_idx on public.snap_phones (account_number);

-- ---------------------------------------------------------------------------
-- Addresses
-- ---------------------------------------------------------------------------
create table if not exists public.snap_addresses (
  id             bigserial primary key,
  account_number bigint not null,
  street         text,
  city           text,
  state          text,
  postal_code    text,
  country        text,
  address_type   text,
  is_primary     boolean not null default false,
  raw            jsonb,
  snapshot_date  date not null,
  loaded_at      timestamptz not null default now()
);
create index if not exists snap_addresses_account_idx on public.snap_addresses (account_number);
create index if not exists snap_addresses_postal_idx  on public.snap_addresses (postal_code);

-- ---------------------------------------------------------------------------
-- Households  (one row per household membership where possible)
-- ---------------------------------------------------------------------------
create table if not exists public.snap_households (
  id             bigserial primary key,
  household_id   bigint,
  account_number bigint,                        -- member (null if the CSV row is household-level only)
  household_name text,
  is_head        boolean,
  raw            jsonb,
  snapshot_date  date not null,
  loaded_at      timestamptz not null default now()
);
create index if not exists snap_households_household_idx on public.snap_households (household_id);
create index if not exists snap_households_account_idx   on public.snap_households (account_number);

-- ---------------------------------------------------------------------------
-- Relationships  (spouse guard reads roles here)
-- ---------------------------------------------------------------------------
create table if not exists public.snap_relationships (
  id                     bigserial primary key,
  account_number         bigint not null,
  related_account_number bigint,
  relationship_type      text,                  -- role, e.g. Spouse / Husband / Wife
  raw                    jsonb,
  snapshot_date          date not null,
  loaded_at              timestamptz not null default now()
);
create index if not exists snap_relationships_account_idx on public.snap_relationships (account_number);
create index if not exists snap_relationships_related_idx on public.snap_relationships (related_account_number);

-- ---------------------------------------------------------------------------
-- Transactions  (Donations + Pledges + PledgePayments flattened; type kept)
-- ---------------------------------------------------------------------------
create table if not exists public.snap_transactions (
  transaction_id        bigint primary key,
  account_number        bigint not null,
  transaction_type      text,                   -- Donation | Pledge | PledgePayment | ...
  amount                numeric,
  transaction_date      date,
  fund                  text,
  campaign              text,
  appeal                text,
  method                text,                   -- payment method
  acknowledgment_status text,
  raw                   jsonb,
  snapshot_date         date not null,
  loaded_at             timestamptz not null default now()
);
create index if not exists snap_transactions_account_idx on public.snap_transactions (account_number);
create index if not exists snap_transactions_amt_date_idx
  on public.snap_transactions (account_number, amount, transaction_date);

-- ---------------------------------------------------------------------------
-- Interactions  (novelty: same account ±3 days, subject trigram similarity)
-- ---------------------------------------------------------------------------
create table if not exists public.snap_interactions (
  interaction_id   bigint primary key,
  account_number   bigint not null,
  subject          text,
  note             text,                        -- body
  channel          text,
  interaction_date timestamptz,
  raw              jsonb,
  snapshot_date    date not null,
  loaded_at        timestamptz not null default now()
);
create index if not exists snap_interactions_account_idx on public.snap_interactions (account_number);
create index if not exists snap_interactions_subject_trgm_idx
  on public.snap_interactions using gin (subject gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Notes
-- ---------------------------------------------------------------------------
create table if not exists public.snap_notes (
  note_id        bigint primary key,
  account_number bigint not null,
  note           text,
  note_date      timestamptz,
  raw            jsonb,
  snapshot_date  date not null,
  loaded_at      timestamptz not null default now()
);
create index if not exists snap_notes_account_idx on public.snap_notes (account_number);

-- ---------------------------------------------------------------------------
-- Attachments  (novelty: filename ≥0.7 similarity)
-- ---------------------------------------------------------------------------
create table if not exists public.snap_attachments (
  attachment_id  bigint primary key,
  account_number bigint,
  filename       text,
  note           text,
  raw            jsonb,
  snapshot_date  date not null,
  loaded_at      timestamptz not null default now()
);
create index if not exists snap_attachments_account_idx on public.snap_attachments (account_number);
create index if not exists snap_attachments_filename_trgm_idx
  on public.snap_attachments using gin (filename gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Tributes
-- ---------------------------------------------------------------------------
create table if not exists public.snap_tributes (
  tribute_id     bigint primary key,
  account_number bigint,
  raw            jsonb,
  snapshot_date  date not null,
  loaded_at      timestamptz not null default now()
);
create index if not exists snap_tributes_account_idx on public.snap_tributes (account_number);

-- ---------------------------------------------------------------------------
-- Sender map + collisions (§3.3) — seed the matcher from the snapshot.
-- ---------------------------------------------------------------------------
create table if not exists public.crm_sender_map (
  email          text primary key,
  constituent_id bigint not null,
  confirmed_by   text not null,                 -- 'snapshot' | reviewer email
  confirmed_at   timestamptz not null default now()
);

create table if not exists public.crm_sender_collision (
  email       text primary key,
  account_ids bigint[] not null,
  reason      text                              -- 'multi_account' | 'shared_mailbox'
);

-- ---------------------------------------------------------------------------
-- Duplicate-constituent worklist (§3.4) — read-only output of the dedupe
-- script. The review UI (authenticated role) reads this; the tiers separate
-- the primary worklist from the shared-mailbox / spouse / low-confidence
-- buckets that must never appear as merge candidates.
-- ---------------------------------------------------------------------------
create table if not exists public.crm_duplicate_candidate (
  id                       bigserial primary key,
  cluster_id               text not null,
  tier                     text not null default 'primary'
                             check (tier in ('primary','shared_mailbox_review','spouse','low_confidence')),
  record_count             int not null,
  normalized_name          text,
  shared_email             text,
  account_numbers          bigint[] not null,
  recommended_survivor     bigint,
  survivor_rationale       text,
  flags                    text[] not null default '{}',  -- both_have_gifts | conflicting_address | same_household
  lifetime_giving_combined numeric,
  crm_urls                 text[],
  generated_at             timestamptz not null default now()
);
create index if not exists crm_duplicate_candidate_tier_idx
  on public.crm_duplicate_candidate (tier);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- snap_* + sender map/collision: service-role only (no policies). §1.8 / §3.
alter table public.snap_constituents   enable row level security;
alter table public.snap_emails         enable row level security;
alter table public.snap_phones         enable row level security;
alter table public.snap_addresses      enable row level security;
alter table public.snap_households     enable row level security;
alter table public.snap_relationships  enable row level security;
alter table public.snap_transactions   enable row level security;
alter table public.snap_interactions   enable row level security;
alter table public.snap_notes          enable row level security;
alter table public.snap_attachments    enable row level security;
alter table public.snap_tributes       enable row level security;
alter table public.crm_sender_map      enable row level security;
alter table public.crm_sender_collision enable row level security;

-- Duplicate worklist: service-role writes; authenticated (review UI) reads.
alter table public.crm_duplicate_candidate enable row level security;
drop policy if exists crm_duplicate_candidate_auth_select on public.crm_duplicate_candidate;
create policy crm_duplicate_candidate_auth_select
  on public.crm_duplicate_candidate
  for select to authenticated
  using (true);

comment on table public.crm_duplicate_candidate is
  'Read-only duplicate-constituent worklist produced by scripts/find-duplicate-constituents.ts from the snap_* snapshot. No writes to Bloomerang — humans merge in the Bloomerang UI. Reviewer (authenticated) role may SELECT; only the service role writes.';
