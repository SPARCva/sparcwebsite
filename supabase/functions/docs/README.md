# `docs` — the documents Debi sends back for editing

Source mirror for the `docs` edge function on Supabase project
`ldxpockcgcxvsrbyhcnt`. Edit here, then deploy.

## Why this exists separately from `daily-sweep`

`email_attachments` already archives files to Drive with sha256 dedupe, and
the build spec says to use it. But every one of its rows was
`kind='check_image'`: the sweep only looks at attachments on the money path
(`from:kat@` with check subjects), so Debi's document threads were never
captured and the table contained no `.docx` or `.pptx` at all.

This adds the missing ingest and writes into the same table, rather than
starting a second archive. The first live scan found six documents in 45 days,
including two carrying 26 and 19 tracked changes.

## Reading a .docx

A `.docx` is a zip; the text is in `word/document.xml` and the comments in
`word/comments.xml`. Debi's tracked changes are `<w:ins>` and `<w:del>` runs,
so both sides fall straight out of the file:

- **her version** — keep `<w:del>` text, drop `<w:ins>` text
- **with her changes** — keep `<w:ins>` text, drop `<w:del>` text

The side-by-side is therefore a read of the file, not a guess at her intent.
Real Word output splits a single edit across several runs, which is why the
parser walks segments in document order rather than matching whole sentences.

## What it does not do

It does **not** rewrite the file and send it back. Producing a revised `.docx`,
or editing a `.pptx` in place, is a write path that does not exist yet. Every
extracted instruction is stored as `needs_human` and stays that way until a
person ticks it off. Nothing here claims to have applied a change it has not.

`diff` is `.docx` only. A `.pptx` or `.xlsx` returns 422 saying so and the
instructions from the covering email are listed instead — those files carry no
tracked-change record to read.

## Actions

`list`, `scan`, `diff`, `instructions_save`, `mark`. Unknown action returns
400 with the valid list.

`instructions_save` takes the whole instruction list back. The column is a
single `jsonb` value, so a partial write would drop the other entries.

## Secrets

`ANTHROPIC_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`SUPABASE_SERVICE_ROLE_KEY` from the function environment. None committed,
none logged.
