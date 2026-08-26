# `tasks` — the Development Dashboard's Today list

Source mirror for the `tasks` edge function on Supabase project
`ldxpockcgcxvsrbyhcnt`. The dashboard frontend lives in
[`SPARCva/sparc-donor-ops`](https://github.com/SPARCva/sparc-donor-ops), which
deliberately holds no backend code — so this is the only version-controlled
copy. **Edit here, then deploy; do not edit the deployed function in place, or
the two drift and this file becomes fiction.**

## What it does

Reads Debi's mail to Erica, extracts what it asks Erica to do, and keeps the
result as a checkable list.

- A **numbered list from Debi is one task per number**, carrying her number in
  `list_index`. She numbers her asks and expects each answered separately.
- A **repeat ask is the same task asked twice**, not a new one: `ask_count`
  goes up and the new message id is appended, rather than a second row.
- Extraction is a model call and only a model call. If the model does not
  return parseable JSON the message is recorded as an error and skipped. There
  is **no regex fallback** — the pre-2026-08-15 pipeline had one, and it read
  email signatures as donor names. That is what `donations_quarantine` holds.

## Actions

`POST` with `{ action, ... }` and `Authorization: Bearer <token>`.

| Action | Body | Behaviour |
|---|---|---|
| `list` | — | Open tasks plus today's unarchived `done` rows, with counts |
| `check` | `{ id, checked }` | Toggle done/open |
| `delete` | `{ id }` | Soft delete; never reaches Completed |
| `add` | `{ title, detail?, due_at? }` | Manual task |
| `update` | `{ id, fields }` | Whitelist: `title`, `detail`, `due_at` |
| `completed` | `{ from, to }` | Rows from `tasks_completed` |
| `export` | `{ scope, date }` | Rows for the client to turn into CSV |
| `scan` | `{ since?, archive?, max_extractions? }` | Incremental scan |
| `backfill` | `{ from, to, max_extractions? }` | Historical scan, same dedupe |

Unknown action returns 400 with the valid list.

## Two things that are load-bearing

**`task_scan_messages` records a verdict for every message, including the
negatives.** Most of Debi's mail contains no task. Without a recorded "nothing
here", those messages are re-extracted on every pass and the scan never
advances — three backfill passes went 11 tasks, 31, then 1 while still
spending the full extraction budget. Improving the prompt later is:

```sql
delete from task_scan_messages where tasks_found <= 0;
```

**`dedupe_key` is checked before repeat detection.** That ordering is the point
of the key: the same ask from the same message is a true no-op. Checking
similarity first instead made every re-scan increment `ask_count`, which
produced "Asked ×6" on tasks Debi had asked for once.

## Resource budget

Every extraction is capped per invocation and both dedupe checks happen before
the model call. `daily-sweep` learned this the hard way: 53 sequential
Anthropic calls in one invocation hit `WORKER_RESOURCE_LIMIT` after staging 15
rows. A month-long backfill is therefore many cheap resumable passes — the
response reports `complete` and `extractions_left` so the caller knows whether
to run it again.

## Scheduling

Three pg_cron jobs at 08:00, 12:00 and 17:00 America/New_York
(`0 12,16,21 * * *` in UTC during EDT). The 17:00 job scans **and then** runs
the archive sweep, in that order. **These hours are wrong from 2 November
2026**, when EST starts — they must become 13, 17 and 22 UTC. That is nine days
before the gala.

Jobs invoke `public.call_edge_svc()`, which authenticates as the
`system:tasks-cron` service account. It does **not** use `call_edge()`: that
helper reads `system_config.cron_token`, which hashes to no `app_sessions` row,
so every job routed through it gets 401 while pg_cron records success — the
request is fired asynchronously and the status is never seen.

**`cron.job_run_details` saying `succeeded` means only that the request was
queued.** To know whether a scan did anything, read `task_scan_runs`.

## Secrets

Reads `ANTHROPIC_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and
`SUPABASE_SERVICE_ROLE_KEY` from the function environment. None are committed
here and none are logged.
