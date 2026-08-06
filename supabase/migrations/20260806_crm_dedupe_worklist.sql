-- SPARC Email → Bloomerang pipeline — Phase 0 duplicate-constituent worklist.
-- Applied to project ldxpockcgcxvsrbyhcnt.
-- ---------------------------------------------------------------------------
-- Builds the read-only merge worklist (crm_duplicate_candidate) from the
-- snap_* snapshot. §3.4 of the build brief. This makes ZERO Bloomerang API
-- calls and never merges anything — humans merge in Bloomerang's own UI. The
-- output is a tiered set of clusters an operator (scripts/find-duplicate-
-- constituents.ts) exports to CSV for Erica to work top-down.
--
-- A cluster is a set of 2+ constituent accounts that share an exact email
-- (all emails compared, not just primary; lowercased/trimmed; plus-tags NOT
-- stripped). Each cluster is tiered:
--   primary               same normalized name + same Type + all active/alive
--                         -> a genuine same-person duplicate to merge.
--   spouse                same email but different people who cohabit (same
--                         last + different first, OR a spouse/husband/wife
--                         relationship, OR a shared household) -> NOT a merge.
--   shared_mailbox_review office/government shared mailbox (info@, chairman@,
--                         *.county.gov, *.va.us, …) -> NOT a merge.
--   low_confidence        shares an email but the names are near-misses,
--                         Types differ, a record is inactive/deceased, or the
--                         addresses are plus-tag variants -> needs a human look.
--
-- Survivor recommendation ranks by transaction count, then profile
-- completeness, then oldest CreatedDate (§3.4).
-- ---------------------------------------------------------------------------

-- ---- normalization helpers (pure; safe to expose) -------------------------
create or replace function public.crm_norm_email(p text) returns text
language sql immutable set search_path = public as $$
  select case when p is null then null else lower(btrim(p)) end;
$$;

create or replace function public.crm_norm_name(p text) returns text
language sql immutable set search_path = public as $$
  -- lower, drop periods/commas, collapse whitespace, strip a trailing suffix.
  -- No nickname expansion (Jen ≠ Jennifer) — deliberately conservative so we
  -- never over-merge.
  select nullif(btrim(
    regexp_replace(
      regexp_replace(
        regexp_replace(lower(coalesce(p,'')), '[.,]', '', 'g'),
        '\s+', ' ', 'g'),
      '\s+(jr|sr|ii|iii|iv)$', '')
  ), '');
$$;

create or replace function public.crm_is_office_email(p text) returns boolean
language sql immutable set search_path = public as $$
  -- Shared office/government mailboxes that must never be treated as one
  -- person (§3.4). Local-part list + government domains.
  select case when p is null or btrim(p) = '' then false else
    split_part(lower(btrim(p)), '@', 1) in
      ('info','office','admin','contact','development','events',
       'chairman','countyboard','braddock')
    or lower(btrim(p)) ~ '@([^@]*county\.gov|[^@]*va\.us|senate\.virginia\.gov|house\.virginia\.gov)$'
  end;
$$;

create or replace function public.crm_email_base(p text) returns text
language sql immutable set search_path = public as $$
  -- Strip a +tag from the local part: x+gala@d -> x@d. Used only to detect
  -- near-miss plus-tag address variants; the map/collision seeding does NOT
  -- strip plus-tags.
  select case when p is null or btrim(p) = '' then null else
    split_part(split_part(lower(btrim(p)), '@', 1), '+', 1) || '@' ||
    split_part(lower(btrim(p)), '@', 2)
  end;
$$;

-- ---- worklist builder -----------------------------------------------------
create or replace function public.crm_build_duplicate_candidates()
returns table(tier text, clusters bigint)
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from crm_duplicate_candidate;

  -- ===== exact-email clusters =====
  with acct_email as (
    select distinct crm_norm_email(e.email) as email, e.account_number as acct
    from snap_emails e
    where e.email is not null and btrim(e.email) <> ''
  ),
  member as (
    select ae.email, ae.acct,
      c.constituent_type as ctype, c.is_inactive, c.is_deceased, c.full_name, c.created_date,
      crm_norm_name(coalesce(nullif(btrim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')),''), c.full_name)) as name_key,
      crm_norm_name(c.last_name) as last_key,
      (select count(*) from snap_transactions t where t.account_number = ae.acct) as txns,
      coalesce((select sum(t.amount) from snap_transactions t where t.account_number = ae.acct), 0) as giving,
      (select min(ad.postal_code) from snap_addresses ad where ad.account_number = ae.acct and ad.postal_code is not null) as zip,
      (select min(h.household_id) from snap_households h where h.account_number = ae.acct) as hh,
      (select count(*) from snap_phones ph where ph.account_number = ae.acct) as phones,
      c.first_name, c.last_name
    from acct_email ae
    join snap_constituents c on c.account_number = ae.acct
  ),
  grp as (
    select email, array_agg(acct order by acct) as accts, count(*) as n,
      count(distinct name_key) as n_names, count(distinct ctype) as n_types,
      count(distinct last_key) filter (where last_key is not null) as n_lasts,
      count(distinct hh) filter (where hh is not null) as n_hh, max(hh) as any_hh,
      bool_or(is_inactive or is_deceased) as any_inactive,
      count(*) filter (where txns > 0) as n_with_gifts,
      count(distinct zip) filter (where zip is not null) as n_zips,
      sum(giving) as giving_sum, crm_is_office_email(email) as is_office
    from member
    group by email
    having count(distinct acct) >= 2
  ),
  grp_flags as (
    select g.*, exists (
      select 1 from snap_relationships r
      where lower(coalesce(r.relationship_type,'')) ~ '(spouse|husband|wife|partner)'
        and r.account_number = any(g.accts) and r.related_account_number = any(g.accts)
    ) as rel_spouse
    from grp g
  ),
  classified as (
    select gf.*, case
      when gf.is_office then 'shared_mailbox_review'
      when gf.n_names = 1 and gf.n_types = 1 and not gf.any_inactive then 'primary'
      when (gf.n_lasts = 1 and gf.n_names >= 2)          -- same last name, different first
        or gf.rel_spouse                                  -- explicit spouse/partner relationship
        or (gf.n_hh = 1 and gf.any_hh is not null and gf.n_names >= 2)  -- same household, different people
        then 'spouse'
      else 'low_confidence'
    end as tier
    from grp_flags gf
  )
  insert into crm_duplicate_candidate
    (cluster_id, tier, record_count, normalized_name, shared_email, account_numbers,
     recommended_survivor, survivor_rationale, flags, lifetime_giving_combined, crm_urls)
  select
    'DUP-' || lpad((row_number() over (order by cl.tier, cl.email))::text, 4, '0'),
    cl.tier, cl.n,
    (select m.full_name from member m where m.email = cl.email
      order by m.txns desc nulls last, m.created_date asc nulls last limit 1),
    cl.email, cl.accts,
    case when cl.tier in ('primary','low_confidence') then (
      select m.acct from member m where m.email = cl.email
      order by m.txns desc,
        ((case when m.zip is not null then 1 else 0 end)
        +(case when m.phones > 0 then 1 else 0 end)
        +(case when m.first_name is not null then 1 else 0 end)
        +(case when m.last_name is not null then 1 else 0 end)) desc,
        m.created_date asc nulls last
      limit 1) end,
    case when cl.tier in ('primary','low_confidence') then (
      select 'Survivor acct '||m.acct||': '||m.txns||' transactions; created '
             ||coalesce(to_char(m.created_date,'YYYY-MM-DD'),'unknown')||'.'
      from member m where m.email = cl.email
      order by m.txns desc,
        ((case when m.zip is not null then 1 else 0 end)
        +(case when m.phones > 0 then 1 else 0 end)
        +(case when m.first_name is not null then 1 else 0 end)
        +(case when m.last_name is not null then 1 else 0 end)) desc,
        m.created_date asc nulls last
      limit 1) end,
    array_remove(array[
      case when cl.n_with_gifts >= 2 then 'both_have_gifts' end,
      case when cl.n_zips >= 2 then 'conflicting_address' end,
      case when cl.n_hh = 1 and cl.any_hh is not null then 'same_household' end
    ], null),
    cl.giving_sum,
    (select array_agg('https://crm.bloomerang.co/Constituent/'||a||'/Profile' order by a) from unnest(cl.accts) a)
  from classified cl;

  -- ===== plus-tag near-miss addresses (x@ vs x+tag@), matching name =====
  -- Separate low-confidence tier per §3.4. Excludes accounts already clustered
  -- above. (No such addresses exist in the current export, but a refresh may
  -- introduce them.)
  with acct_email as (
    select distinct crm_norm_email(e.email) as email, e.account_number as acct
    from snap_emails e
    where e.email is not null and btrim(e.email) <> ''
  ),
  m as (
    select ae.email, ae.acct, crm_email_base(ae.email) as base,
      crm_norm_name(coalesce(nullif(btrim(coalesce(c.first_name,'')||' '||coalesce(c.last_name,'')),''), c.full_name)) as name_key,
      c.full_name,
      coalesce((select sum(t.amount) from snap_transactions t where t.account_number = ae.acct), 0) as giving
    from acct_email ae
    join snap_constituents c on c.account_number = ae.acct
    where not exists (
      select 1 from crm_duplicate_candidate d where ae.acct = any(d.account_numbers)
    )
  ),
  base_grp as (
    select base,
      array_agg(distinct acct order by acct) as accts,
      count(distinct acct) as n,
      count(distinct email) as raw_variants,
      count(distinct name_key) as n_names,
      sum(giving) as giving_sum,
      (array_agg(full_name order by giving desc))[1] as disp_name
    from m
    group by base
    having count(distinct acct) >= 2
       and count(distinct email) >= 2      -- genuinely different raw addresses
       and count(distinct name_key) = 1    -- same person
  )
  insert into crm_duplicate_candidate
    (cluster_id, tier, record_count, normalized_name, shared_email, account_numbers,
     recommended_survivor, survivor_rationale, flags, lifetime_giving_combined, crm_urls)
  select
    'DUPP-' || lpad((row_number() over (order by bg.base))::text, 4, '0'),
    'low_confidence', bg.n, bg.disp_name, bg.base, bg.accts,
    bg.accts[1],
    'Plus-tag address variants of the same person; confirm before merging.',
    array['plus_tag_near_miss'],
    bg.giving_sum,
    (select array_agg('https://crm.bloomerang.co/Constituent/'||a||'/Profile' order by a) from unnest(bg.accts) a)
  from base_grp bg;

  return query
    select d.tier, count(*) from crm_duplicate_candidate d group by d.tier order by d.tier;
end $$;

-- Lock down RPC exposure: crm_build_duplicate_candidates reads the RLS-locked
-- snap_* tables, so it must not be callable by anon/authenticated (§4.6).
revoke all on function public.crm_build_duplicate_candidates() from public, anon, authenticated;
grant execute on function public.crm_build_duplicate_candidates() to service_role;

comment on function public.crm_build_duplicate_candidates() is
  'Rebuilds crm_duplicate_candidate (the merge worklist) from the snap_* snapshot. Makes zero Bloomerang calls; never merges. §3.4. Service-role only.';
