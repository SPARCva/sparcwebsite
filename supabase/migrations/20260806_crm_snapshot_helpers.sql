-- SPARC Email → Bloomerang pipeline — Phase 0 snapshot helpers.
-- Applied to project ldxpockcgcxvsrbyhcnt.
-- ---------------------------------------------------------------------------
-- Two service-role-only helpers the loader (scripts/load-bloomerang-snapshot.ts)
-- calls:
--   snap_reset()          — truncate every snap_* table + the sender tables so
--                           the load is a clean truncate-and-reload (§3.2).
--   crm_seed_sender_map() — rebuild crm_sender_map / crm_sender_collision from
--                           snap_emails (§3.3): an email on exactly one account
--                           becomes a confirmed sender; an email on 2+ accounts
--                           becomes a collision (and never auto-matches).
--
-- Both are SECURITY DEFINER and, per the repo's established pattern (§4.6),
-- have EXECUTE revoked from public/anon/authenticated and granted only to
-- service_role — SECURITY DEFINER functions are otherwise auto-exposed as
-- PostgREST RPC endpoints callable with just the anon key.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- snap_reset — clean slate for a fresh load. Truncating the snap_* tables also
-- means the loader is safe to re-run and to use for the pre-Phase-3 refresh.
-- ---------------------------------------------------------------------------
create or replace function public.snap_reset()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  truncate table
    snap_constituents, snap_emails, snap_phones, snap_addresses,
    snap_households, snap_relationships, snap_transactions,
    snap_interactions, snap_notes, snap_attachments, snap_tributes,
    crm_sender_map, crm_sender_collision
  restart identity;
end $$;

-- ---------------------------------------------------------------------------
-- crm_seed_sender_map — §3.3. Rebuilds both tables from snap_emails.
--   * email normalized to lower(btrim(...)); blank/null skipped.
--   * plus-tags are NOT stripped (near-miss addresses are a separate dedupe
--     tier, not a collision here).
--   * one distinct account  -> crm_sender_map (confirmed_by='snapshot').
--   * 2+ distinct accounts   -> crm_sender_collision. reason='shared_mailbox'
--     when the address is a known office mailbox (local part or government
--     domain per §3.4), else 'multi_account'.
-- Idempotent: clears both tables first, so re-running after a refresh is safe.
-- ---------------------------------------------------------------------------
create or replace function public.crm_seed_sender_map()
returns table (sender_count bigint, collision_count bigint)
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from crm_sender_map;
  delete from crm_sender_collision;

  with e as (
    select lower(btrim(email)) as email, account_number
      from snap_emails
     where email is not null and btrim(email) <> ''
  ),
  grp as (
    select email, array_agg(distinct account_number order by account_number) as ids
      from e
     group by email
  )
  insert into crm_sender_map (email, constituent_id, confirmed_by)
  select email, ids[1], 'snapshot'
    from grp
   where array_length(ids, 1) = 1;

  with e as (
    select lower(btrim(email)) as email, account_number
      from snap_emails
     where email is not null and btrim(email) <> ''
  ),
  grp as (
    select email, array_agg(distinct account_number order by account_number) as ids
      from e
     group by email
  )
  insert into crm_sender_collision (email, account_ids, reason)
  select
    email,
    ids,
    case
      when split_part(email, '@', 1) in
             ('info','office','admin','contact','development','events',
              'chairman','countyboard','braddock')
        or email ~ '@([^@]*county\.gov|[^@]*va\.us|senate\.virginia\.gov|house\.virginia\.gov)$'
      then 'shared_mailbox'
      else 'multi_account'
    end
    from grp
   where array_length(ids, 1) >= 2;

  return query
    select (select count(*) from crm_sender_map),
           (select count(*) from crm_sender_collision);
end $$;

-- Lock down RPC exposure (SECURITY DEFINER → revoke from public/anon/auth).
revoke all on function public.snap_reset()          from public, anon, authenticated;
revoke all on function public.crm_seed_sender_map() from public, anon, authenticated;
grant execute on function public.snap_reset()          to service_role;
grant execute on function public.crm_seed_sender_map() to service_role;

comment on function public.crm_seed_sender_map() is
  'Rebuilds crm_sender_map (email→single constituent, confirmed_by=snapshot) and crm_sender_collision (email on 2+ accounts) from snap_emails. §3.3. Service-role only.';
