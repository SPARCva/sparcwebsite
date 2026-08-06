# SPARC Email → Bloomerang pipeline — operator scripts

Node/TypeScript scripts an operator runs out-of-band (with the Supabase
service-role key). They are **not** part of the Netlify site build and are not
deployed anywhere. Run them from this `scripts/` directory.

```bash
cd scripts
npm install          # once
```

## `load-bloomerang-snapshot.ts` — Phase 0 snapshot load (§3.2 / §3.3)

Loads a Bloomerang CSV export into the read-only `snap_*` reference tables and
rebuilds the sender-map / collision tables. This is the input to the duplicate
worklist (step 3) and to the backfill novelty checks (later). It writes **only**
to Supabase `snap_*` and `crm_sender_*` tables — it never touches Bloomerang.

It is a **truncate-and-reload** (`snap_reset()` runs first), so it is safe to
re-run and is exactly what the pre-Phase-3 snapshot refresh uses.

### 1. Get the export onto disk

Erica exports the full database from Bloomerang (Settings → Export) and the
files land in Google Drive — e.g. the folder **`DataExport-2026-08-06`**
(`1h_469LwkMKNMs1_eI0k4oqCuvP2uTJY7`). Download that folder so you have a local
directory of `*.csv` (Constituents.csv, Emails.csv, Transactions.csv, …).

These files contain donor and **participant** program data (disability status,
DSP details, emergency contacts). Keep the local copy private and delete it
when the load is done; the `snap_*` tables it loads into are service-role only
under RLS.

### 2. Dry run (no DB connection, no writes)

Parses and maps every CSV and prints per-table row counts and one sample
record. Use it to confirm the export parses before touching the database.

```bash
EXPORT_DIR=/path/to/DataExport-2026-08-06 \
  npx tsx load-bloomerang-snapshot.ts --dry-run
```

### 3. Real load

```bash
EXPORT_DIR=/path/to/DataExport-2026-08-06 \
SUPABASE_URL=https://ldxpockcgcxvsrbyhcnt.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<service-role key> \
  npx tsx load-bloomerang-snapshot.ts
```

Optional `SNAPSHOT_DATE=YYYY-MM-DD` (defaults to today) is stamped on every row.

### What it loads

| CSV | → table | notes |
|---|---|---|
| Constituents.csv | `snap_constituents` | `Custom: Role at SPARC` kept; Status → inactive/deceased flags |
| Emails.csv | `snap_emails` | `Value` = address, `TypeName`, `IsPrimary` |
| Phones.csv | `snap_phones` | |
| Addresses.csv | `snap_addresses` | `Street` may contain embedded newlines |
| Households.csv | `snap_households` | expanded to one row per member account (`Head` + pipe-delimited `Members`) |
| Relationships.csv | `snap_relationships` | `AccountNumber1/2`, `Role1` |
| Transactions.csv | `snap_transactions` | `TransactionNumber` = id, de-duped; amount/date/method |
| Interactions.csv | `snap_interactions` | `Note` holds long multi-line bodies |
| Notes.csv | `snap_notes` | |
| FileAttachments.csv | `snap_attachments` | no account/id in the export → surrogate id, linkage kept in `raw` |
| Tributes.csv | `snap_tributes` | no account/id → surrogate id |

Every row also stores the complete original CSV row in a `raw` jsonb column, so
no exported field is lost even when it has no dedicated column.

After loading, it calls `crm_seed_sender_map()`, which rebuilds:

- **`crm_sender_map`** — every email that maps to exactly one constituent
  (`confirmed_by = 'snapshot'`).
- **`crm_sender_collision`** — every email on 2+ constituents. These never
  auto-match and are the dedupe input. Office/government mailboxes
  (`info@`, `office@`, `*.county.gov`, `*.va.us`, `senate/house.virginia.gov`,
  …) are tagged `shared_mailbox`; the rest `multi_account`.

Emails are normalized (lowercased, trimmed) but plus-tags are **not** stripped
(near-miss addresses are handled as a separate dedupe tier, not merged here).

### Ordering

1. Run this loader.
2. Run the duplicate worklist (`find-duplicate-constituents.ts`, step 3); Erica
   merges duplicates in the Bloomerang UI.
3. Before Phase 3 (backfill), export again and **re-run this loader** so the
   snapshot reflects the merges and any new activity.
