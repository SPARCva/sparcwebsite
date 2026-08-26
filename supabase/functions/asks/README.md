# `asks` — answering Debi, and chasing the people behind her asks

Source mirror for the `asks` edge function on Supabase project
`ldxpockcgcxvsrbyhcnt`. Edit here, then deploy.

Both features live in one function because they share the same plumbing:
session auth, the Gmail token, the thread fetch and the Anthropic call.

## The verification gate is the point of this function

Debi's 24 August memo lists five factual errors in a report Erica sent —
institutions named with no attributable individual, a conversion figure with
no derivation, an anonymous donor written about as if identified. Every one is
the same failure: prose that reads as sourced but is not.

So the generator grades its own output and hands back what it could not stand
behind:

| Flag | Meaning |
|---|---|
| `unsourced_claim` | Stated something the thread does not support, or left a gap |
| `missing_interpretation` | Gave numbers without saying what they mean |
| `filler` | Words that add length but no information |
| `repeat_ask` | Debi has asked this more than once |

Where a fact cannot be sourced the draft writes a `[bracketed placeholder]`
and flags it. It never invents a name, figure, institution or date.

Two things are enforced in code rather than trusted to the model:

- A placeholder left in the text sets `unsourced_claim` **whether or not the
  model remembered to flag it**. The text is trusted over the self-report.
- A task with no email behind it (`source='manual'`, or no thread) is refused
  outright. There is nothing to source an answer from, so drafting one would
  mean inventing the facts.

## Nothing here emails Debi

Approved answers assemble into a single Gmail **draft**, in her original
numbering, for Erica to read and send herself. Follow-ups do send, but one at
a time, each on its own approval, and a send is refused if the text still
contains a placeholder — otherwise `[date]` reaches a donor.

A follow-up's recipient is only ever an address that appeared in the thread.
If the generator could not find one it returns null and the UI asks for it. A
guessed address sends SPARC's business to a stranger.

## Actions

`list`, `generate`, `save`, `approve`, `unstage`, `dismiss`, `create_draft`,
`followups`, `followup_generate`, `followup_save`, `followup_send`,
`followup_answered`, `followup_dismiss`. Unknown action returns 400 with the
valid list.

## Secrets

`ANTHROPIC_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`SUPABASE_SERVICE_ROLE_KEY` from the function environment. None committed,
none logged.
